/**
 * 一候选工作区里的一张图片：GET `/api/runs/[runId]/candidates/[candidateId]/image?path=RESULT.svg.png`。
 *
 * 出处是 `image-view` 块（模型看过的一张图）。界面把块的厂商路径**换算成工作区相对路径**再进 URL：
 * 这里只收相对路径（core 的第一道门），`realpath` 复核是第二道。
 *
 * 响应是**原始字节**而不是 JSON：它要直接当 `<img src>` 用。`cache-control: no-store` 是刻意的——
 * 工作区在运行结束后会被改写，缓存一张已经删掉的图会让界面显示「还在」。
 *
 * 两个安全头：`x-content-type-options: nosniff` 不让浏览器猜类型；`content-security-policy` 的
 * `sandbox` + `default-src 'none'` 管的是**直接打开这个 URL** 的那条路——工作区里的 SVG 是模型写的，
 * 顶层文档里的 `<script>` 会以本页同源执行；`<img>` 里的同一份 SVG 不会执行脚本，两条路必须分开看。
 *
 * **不要再 `decodeURIComponent` 一次**：`searchParams.get` 已经解过码了，再解一次会让含 `%`
 * 的真实文件名抛 `URIError` ⇒ 500（与产物与变更详情两条路由同一条坑）。
 */
import { ServiceError } from '@aieval/contracts';
import { getCandidateWorkspaceImage } from '@aieval/api';
import { handleApiError } from '@/src/server-context';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ runId: string; candidateId: string }> },
): Promise<Response> {
  try {
    const { runId, candidateId } = await params;
    const path = new URL(req.url).searchParams.get('path');
    if (path === null || path === '') {
      // 缺参数与「路径不合法」分开说：前者是调用方漏了一格，后者由 core 的判据回
      throw new ServiceError('INVALID_QUERY', '缺少 path：一次只取一张图片');
    }
    const { bytes, mimeType } = getCandidateWorkspaceImage(runId, candidateId, path);
    return new Response(new Uint8Array(bytes), {
      headers: {
        'content-type': mimeType,
        'content-length': String(bytes.byteLength),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': 'default-src \'none\'; sandbox',
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
