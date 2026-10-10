// @vitest-environment node
/** 窄读取：厂商负载是 unknown，读之前必须先收窄；读不到一律 null，且永不抛。 */
import { describe, expect, it } from 'vitest';
import { asRecord, readNumber, readString } from './json';

describe('asRecord', () => {
  it('只接受非数组对象（数组 / null / 基本类型一律 null；类实例算对象）', () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord([1, 2])).toBeNull();
    expect(asRecord(null)).toBeNull();
    expect(asRecord('x')).toBeNull();
    expect(asRecord(undefined)).toBeNull();
    // 类实例是「非数组对象」，按实现接受——`statusOf` 正要在 Error 实例上读 status，注释不能承诺「只收普通对象」
    expect(asRecord(new Date())).not.toBeNull();
  });
});

describe('readString / readNumber', () => {
  it('类型不对就是 null（不把数字当字符串、不把字符串当数字）', () => {
    const source = asRecord({ s: 'x', n: 3, nan: Number.NaN, inf: Number.POSITIVE_INFINITY, empty: '' });
    expect(readString(source, 's')).toBe('x');
    expect(readString(source, 'n')).toBeNull();
    expect(readNumber(source, 'n')).toBe(3);
    expect(readNumber(source, 'nan')).toBeNull();
    expect(readNumber(source, 'inf')).toBeNull();
    expect(readString(source, 'empty')).toBe('');
    expect(readString(source, 'missing')).toBeNull();
    expect(readNumber(null, 'n')).toBeNull();
  });
});

describe('读不到就不许抛', () => {
  it('带抛错 getter 的负载：三个函数都不抛，并按「没有该字段」返回', () => {
    /**
     * 为什么这条是承重的：文件头把「一律不抛」写成本层存在的理由——厂商负载是 `unknown`，窄读取层的
     * 全部价值就是**任何**输入都不炸。而 `source?.[key]` 会触发 getter / Proxy trap，抛出去就冒进
     * 适配器主流程（正是 `emit.ts` 的 `safeStringify` 注释里那条「丢事件比丢格式更糟」的教训）。
     */
    const bomb = {
      get boom(): string {
        throw new Error('getter 抛错');
      },
    };
    expect(() => asRecord(bomb)).not.toThrow();
    expect(() => readString(asRecord(bomb), 'boom')).not.toThrow();
    expect(() => readNumber(asRecord(bomb), 'boom')).not.toThrow();
    expect(readString(asRecord(bomb), 'boom')).toBeNull();
    expect(readNumber(asRecord(bomb), 'boom')).toBeNull();
  });

  it('代理在类型探测上也抛错时同样不抛（Proxy 的 getPrototypeOf 陷阱）', () => {
    const hostile = new Proxy(
      {},
      {
        get(): never {
          throw new Error('proxy get 抛错');
        },
        getPrototypeOf(): never {
          throw new Error('proxy getPrototypeOf 抛错');
        },
      },
    );
    expect(() => asRecord(hostile)).not.toThrow();
    expect(() => readString(asRecord(hostile), 'any')).not.toThrow();
    expect(readString(asRecord(hostile), 'any')).toBeNull();
  });
});
