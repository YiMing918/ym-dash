// Pages Functions 入口：/api/* 全部转发到 _lib/router.js 的 handle（逻辑在那边，方便本地冒烟直调）
import { handle } from '../_lib/router.js';

export async function onRequest(context) {
  return handle(context);
}
