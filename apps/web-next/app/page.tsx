import { redirect } from 'next/navigation';

/** 默认落地页：核心动作是「创建评测 → 跑 → 看分」，故直接进评测列表。 */
export default function Page(): never {
  redirect('/runs');
}
