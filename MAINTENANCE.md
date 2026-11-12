# ym-dash · 维修手册（MAINTENANCE）

给维护者（包括未来的自己与接手的 AI）：数据键表、故障对照、恢复方法、双份探活逻辑的同步对照都在这里。先看这份，再动代码。

## 数据键表（Workers KV，绑定名 DASH_KV）

| 键 | 内容 | 谁写 | 备注 |
|---|---|---|---|
| `sites` | 站点数组 `[{id,name,url,note,createdAt}]` | 管理 API | 删站时同步保存新数组 |
| `histall` | 全部站点的最近 96 条检测 `{v:1, sites:{<siteId>:[{t,up,status,ms,err}]}}`，新在前 | API 探活 / Worker | 一轮全量探活只写 1 次（合并存储，见 store.js 的 loadHistBatch）；删站时连带移除该站条目 |
| `hist:<siteId>` | 旧版式历史键（同上结构的单站数组） | —（不再写入） | 只读回退：合并键里没有该站时读它衔接存量历史；删站时连带删除，可手动清理 |
| `state:<siteId>` | 当前状态 `{up, since}` | 同上 | 算掉线时长、判定状态变化生成事件；删站时连带删除 |
| `events` | 最近 100 条事件 `[{t,siteId,name,type:'down'\|'up',detail}]`，新在前 | 同上 | 删站不删旧事件，自然顶替 |
| `meta` | `{lastCheckAt}` 最近一次全量探活时间 | 同上 | 页面汇总条的「最近检测」 |
| `settings` | `{title}` 站点标题 | 管理 API | 缺失时默认「站点总览」 |
| `admin` | `{username,salt,hash,createdAt}` 站长账号 | 初始化接口 | **删掉此键 = 回到未初始化状态**（重新初始化即重置密码） |
| `session:<token>` | `{username, exp}` 会话，7 天过期 | 登录 / 初始化 | 退出或过期自动失效；可批量删以前缀 `session:` 开头的键踢掉所有登录 |
| `login_guard` | `{fails, lockUntil}` 登录失败计数与锁定期 | 登录接口 | 连错 5 次锁 15 分钟；手动解锁定删此键 |

## 探活逻辑双份同步对照（重要）

Worker 独立部署、不能跨目录 import，探活逻辑全仓有**两份实现，必须同改**：

| 逻辑 | 站点侧 | Worker 侧 |
|---|---|---|
| 网址 SSRF 校验 `validateUrl` | `functions/_lib/probe.js` | `worker/worker.js` 内同名函数 |
| 探活 `probeUrl` | `functions/_lib/probe.js` | `worker/worker.js` 内同名函数 |
| 落库 `checkSite` / 全量 `runCheckAll` | `functions/_lib/store.js` | `worker/worker.js` 内同名函数 |
| 容量常量 | `store.js` 的 `HIST_CAP` / `EVENTS_CAP` | `worker.js` 顶部同名常量 |

改动清单口诀：搜全仓 `probeUrl` 与 `validateUrl`，命中的实现只有这两处；改完两边都过一遍 `node --check`，再跑 `node scripts/smoke.mjs`（其中场景 E 专门守 Worker 侧的 SSRF 副本）。

两边有一处**故意的不一致**：站点侧 `checkSite` 不重复校验网址（加站/改站时已经校验过），Worker 侧多一层守卫——防的是有人绕过 API 直接往 KV 塞内网地址时 Worker 照单全收去探。别把这层守卫「优化」掉。

## 故障对照

| 现象 | 先查 | 多半是 |
|---|---|---|
| 打开页面「加载失败…KV 还没绑好」 | Pages 设置 → 绑定 | 绑定名不是 `DASH_KV`，或绑完没重新部署 |
| 检测时间一直不变、历史不增长 | Worker 的触发器与绑定 | Cron 没加（`*/30 * * * *`）、Worker 绑的 KV id 与主站不是同一个、Worker 部署失败 |
| 直接访问 Worker 地址无在岗说明 | Workers 列表 | Worker 没部署成功，或域名/路由被改 |
| 加站报「不允许内网 / 回环地址」 | 输入的网址 | 触发了 SSRF 校验；确认不是内网地址后检查是否写了 `.local` 结尾或 IP 字面量 |
| 某站一直显示异常但浏览器能打开 | 该站对机房 IP 的策略 | Cloudflare 出口被对方拦（如返回 403/412）；这是已知边界，不是本站故障 |
| 登录提示已锁定 | KV 的 `login_guard` | 连错 5 次触发 15 分钟锁定；等过期，或后台删掉 `login_guard` 键立即解锁 |
| 改了标题不生效 | 浏览器缓存 | 标题走 API 实时读，强刷一次；还不行查 `settings` 键是否写入 |
| 可用率怪（如新站 0%/100% 跳） | 样本量 | 新站记录太少属正常，攒够一天记录再看 |

## 恢复方法

- **忘记站长密码**：Cloudflare 后台 → KV → 打开本站命名空间 → 删除 `admin` 键（可顺手删掉所有 `session:` 前缀的键）→ 打开站点，右上角回到「站长初始化」，重设账号密码即可。站点、历史、事件数据都不受影响。
- **怀疑账号被盗**：删 `admin` 重置密码 + 删全部 `session:` 键（踢掉所有已登录会话），再检查 `sites` 里有没有被加的陌生站。
- **数据写坏 / 想重开**：删 `sites`、`events`、`meta`、`histall` 与全部 `hist:`、`state:` 前缀键，等于清空监控数据（站点列表也没了，慎用）。
- **整站搬家**：KV 支持整命名空间导出/导入的第三方工具较多；最稳妥的土办法是部署好新站后，用旧站登录态调 `GET /api/sites` 拿到站点清单，在新站逐个重新添加（历史不迁移）。

## 本地自测

```bash
node --check functions/_lib/*.js functions/api/*.js worker/worker.js
node scripts/smoke.mjs   # 内存 KV + 打桩 fetch，不依赖外网；当前 35 项断言
```

改任何探活/数据结构代码后，smoke 必须全绿再部署。

## 额度备忘（免费版）

- KV 写入约 1,000 次/天（全账号共享）：一轮全量探活固定写 `histall` 1 次 + `meta` 1 次，状态翻转时每个翻转站再加 `state:` 与 `events` 各 1 次。当前每 30 分钟一轮 ≈ 100 次/天量级，与站数基本无关（旧版式每站一键时是 站数 × 48 × 约 1 次，已弃用）。
- KV 读取约 100,000 次/天：公开页每次打开读 sites + 每站各读一次 hist/state，个人量级无压力；被刷时先考虑给 Pages 加缓存或限流规则。
- Workers 请求（探活 Worker 本身）免费版 100,000 次/天，探活是 Cron 内部执行，主要消耗在它发出的 fetch 子请求上，个人量级无压力。
