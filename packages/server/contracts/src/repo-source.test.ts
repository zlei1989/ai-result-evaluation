// @vitest-environment node
/**
 * 来源形态判定：本地绝对路径 vs 远端 git 地址。
 * 三条容易写错的地方（每条都对应一个真实误判）：
 *   1. Windows 盘符与 UNC 必须先于 URL 判定（spec 的判定顺序；`D:` 这种单字母 host 当前 `SCP_LIKE`
 *      本就吞不掉，这条分支守的是顺序本身——防御性代码，不是正则冲突）；
 *   2. scp 形态要额外要求「含 @ 或 host 段含点」，否则 `src:foo` 这种含冒号的相对路径会被判成远端；
 *   3. 归一只有「两侧空白 + 远端尾斜杠」两条——多归一一条，两个不同的远端就会指向同一份镜像。
 */
import { describe, expect, it } from 'vitest';
import { ServiceError } from './errors';
import { normalizeRemoteUrl, parseRepoSource, RepoSourceStringSchema, displayRepoName, repoNameFromSource } from './repo-source';

describe('parseRepoSource', () => {
  it('Windows 盘符与 UNC 一律本地（先于 URL 判定）', () => {
    expect(parseRepoSource('D:\\repos\\demo')).toEqual({ kind: 'local', path: 'D:\\repos\\demo' });
    expect(parseRepoSource('D:/repos/demo')).toEqual({ kind: 'local', path: 'D:/repos/demo' });
    expect(parseRepoSource('\\\\host\\share\\repo')).toEqual({ kind: 'local', path: '\\\\host\\share\\repo' });
  });

  it('POSIX 绝对路径、相对路径、含冒号的相对路径都是本地', () => {
    expect(parseRepoSource('/home/me/repo').kind).toBe('local');
    expect(parseRepoSource('./repo').kind).toBe('local');
    // 含冒号但不是 scp 形态：host 段无点、无 @
    expect(parseRepoSource('src:foo').kind).toBe('local');
    expect(parseRepoSource('localhost:repo').kind).toBe('local');
  });

  it('五种白名单 scheme 是远端，并解析出 host 与仓库名', () => {
    expect(parseRepoSource('https://coding.jd.com/FlowAI/rbac-server.git')).toEqual({
      kind: 'remote',
      url: 'https://coding.jd.com/FlowAI/rbac-server.git',
      host: 'coding.jd.com',
      repoName: 'rbac-server',
    });
    // RepoSource 是联合类型，远端专有字段只能整对象比对（直接 `.host` 过不了 strict）
    expect(parseRepoSource('ssh://git@coding.jd.com:2222/FlowAI/rbac-server.git')).toMatchObject({ host: 'coding.jd.com' });
    expect(parseRepoSource('git://github.com/x/y.git')).toMatchObject({ repoName: 'y' });
    expect(parseRepoSource('file:///D:/tmp/origin.git')).toEqual({
      kind: 'remote',
      url: 'file:///D:/tmp/origin.git',
      host: 'localhost',
      repoName: 'origin',
    });
  });

  it('scp 形态：含 @ 或 host 段含点才算远端', () => {
    expect(parseRepoSource('git@coding.jd.com:FlowAI/rbac-server.git')).toEqual({
      kind: 'remote',
      url: 'git@coding.jd.com:FlowAI/rbac-server.git',
      host: 'coding.jd.com',
      repoName: 'rbac-server',
    });
    expect(parseRepoSource('github.com:x/y.git').kind).toBe('remote');
  });

  it('scp 形态与 URL 形态同一归一：尾斜杠不留在 url 里，仓库名也取自归一后的串', () => {
    expect(parseRepoSource('git@host:group/repo.git/')).toEqual({
      kind: 'remote',
      url: 'git@host:group/repo.git',
      host: 'host',
      repoName: 'repo',
    });
  });

  it('两侧空白与远端尾斜杠按归一处理，其余不做归一', () => {
    expect(parseRepoSource('  D:\\repos\\demo  ')).toEqual({ kind: 'local', path: 'D:\\repos\\demo' });
    expect(parseRepoSource(' https://host/x.git/ ')).toMatchObject({ url: 'https://host/x.git' });
    expect(normalizeRemoteUrl('  https://host/x.git/ ')).toBe('https://host/x.git');
    // 大小写与 .git 后缀都不归一：它们是镜像 key 与「来源是否改变」的判据
    expect(normalizeRemoteUrl('https://HOST/X.GIT')).toBe('https://HOST/X.GIT');
  });

  it('非白名单协议直接拒绝，文案点名协议', () => {
    const caught = (() => {
      try {
        parseRepoSource('ftp://host/x.git');
        return null;
      } catch (error) {
        return error as ServiceError;
      }
    })();
    expect(caught?.code).toBe('INVALID_QUERY');
    expect(caught?.message).toContain('ftp');
  });

  it('含控制字符或以 - 开头一律拒绝（参数注入面）', () => {
    const control = (() => {
      try {
        parseRepoSource('https://host/x.git\n');
        return null;
      } catch (error) {
        return error as ServiceError;
      }
    })();
    expect(control?.code).toBe('INVALID_QUERY');
    expect(control?.message).toContain('控制字符');

    const dash = (() => {
      try {
        parseRepoSource('--upload-pack=calc');
        return null;
      } catch (error) {
        return error as ServiceError;
      }
    })();
    expect(dash?.code).toBe('INVALID_QUERY');
    expect(dash?.message).toContain('不能以 - 开头');
  });
});

describe('repoNameFromSource', () => {
  it('远端取归一后末段去 .git，没有路径段时回落 host；本地取路径末段', () => {
    expect(repoNameFromSource('git@coding.jd.com:FlowAI/rbac-server.git')).toBe('rbac-server');
    // 仓库名与镜像 key 同归一（先剥尾分隔符再取末段），下面三条钉住这个口径
    expect(repoNameFromSource('https://host/')).toBe('host'); // 没有路径段时才回落主机名
    expect(repoNameFromSource('https://host/x.git/')).toBe('x'); // 尾斜杠与镜像 key 的归一口径一致
    expect(repoNameFromSource('https://host/group/')).toBe('group'); // 尾斜杠不是「空末段」
    expect(repoNameFromSource('D:\\repos\\demo\\')).toBe('demo');
    expect(repoNameFromSource('/home/me/tool-id')).toBe('tool-id');
  });
});

/**
 * 展示用的取名：**任何字符串都不抛错**。
 *
 * 为什么需要它而不是直接用 `repoNameFromSource`：那条是**判定路径**的函数，对非白名单 scheme、
 * 控制字符、`-` 开头是响亮地抛错（写路径就该这样）。但列表的「仓库名」列与「创建评测」的用例下拉
 * 是在**渲染期**取名字的，而读路径不保证来源合法——`loadConfig()` 不校验 `cases`，本功能之前的用例
 * schema 还是裸的 `z.string()`，所以历史 config.json 里可能有任何字符串。一个坏行抛在渲染里就是整页白屏，
 * 而不是一行难看的文字（被替换掉的 `repoNameOf` 从不抛错，它的用例名就叫「列表里不该因为一条坏数据整页崩掉」）。
 */
describe('displayRepoName', () => {
  it('合法来源与 repoNameFromSource 逐字一致（展示不另立一套口径）', () => {
    for (const source of [
      'git@coding.jd.com:FlowAI/rbac-server.git',
      'https://host/group/repo.git',
      'https://host/x.git/',
      'D:\\repos\\demo\\',
      'D:\\repos\\demo',
      '/home/me/tool-id',
      'git@host:group/repo.git',
    ]) {
      expect(displayRepoName(source)).toBe(repoNameFromSource(source));
    }
  });

  it('任何字符串都不抛错（空串 / 空白 / 分隔符 / 畸形 scheme / 控制字符 / - 开头）', () => {
    const hostile = [
      '',
      '   ',
      '\t',
      '/',
      '\\\\',
      'ftp://host/x.git',
      'ftp://',
      'D:\\repos\\de\nmo',
      '--upload-pack=calc',
      '-',
      '://x',
      'x'.repeat(500),
    ];
    for (const source of hostile) {
      expect(() => displayRepoName(source)).not.toThrow();
      expect(typeof displayRepoName(source)).toBe('string');
    }
  });

  it('判定会抛的来源退化成「末段去 .git」，仍读得出来', () => {
    expect(displayRepoName('ftp://host/x.git')).toBe('x');
    // 没有路径段时取 host 段（与合法 URL 的口径一致，不编造主机名）
    expect(displayRepoName('ftp://host/')).toBe('host');
    // 粘贴事故（换行）与 git 参数注入形态：末段 / 原样回显，绝不抛
    expect(displayRepoName('D:\\repos\\de\nmo')).toBe('de\nmo');
    expect(displayRepoName('--upload-pack=calc')).toBe('--upload-pack=calc');
  });

  it('空白来源给空串（回显一片空白也比抛错好，但不要把不可见的空白当名字）', () => {
    expect(displayRepoName('')).toBe('');
    expect(displayRepoName('   ')).toBe('');
    expect(displayRepoName('\t')).toBe('');
  });
});

describe('RepoSourceStringSchema', () => {
  it('合法来源通过，非法来源带上 ServiceError 的中文原因', () => {
    expect(RepoSourceStringSchema.safeParse('D:\\repos\\demo').success).toBe(true);
    expect(RepoSourceStringSchema.safeParse('git@host:group/repo.git').success).toBe(true);
    const parsed = RepoSourceStringSchema.safeParse('ftp://host/x.git');
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.success ? [] : parsed.error.issues)).toContain('不支持的 git 地址协议');
  });

  it('空串与纯空白串都拒绝，且都由 schema 给出中文原因（不回落 zod 的英文默认文案）', () => {
    for (const blank of ['', '   ']) {
      const parsed = RepoSourceStringSchema.safeParse(blank);
      expect(parsed.success).toBe(false);
      const messages = parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
      expect(messages).toContain('代码来源不能为空');
    }
  });
});
