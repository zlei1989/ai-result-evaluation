/**
 * 创建评测表单的候选池 + 三种智能体的能力元数据。
 * 为什么需要独立一条路由：候选池的协议过滤判据是 agents 注册表元数据（A3），
 * 而路由表里没有承载它的位置；把「哪家智能体配哪种协议」抄到前端是最坏的替代。
 * 本路由只做投影透传，不含业务规则（投影本身在 api 的 listModelOptions / listAgentModelOptions）。
 */
import { listAgentModelOptions } from '@aieval/api';
import { handleApiError } from '@/src/server-context';

export async function GET(): Promise<Response> {
  try {
    return Response.json(listAgentModelOptions());
  } catch (error) {
    return handleApiError(error);
  }
}
