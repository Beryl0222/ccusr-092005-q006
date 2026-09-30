# 球迷共创城市记忆

保存球迷旗帜、口号、影像与城市打卡点之间的**权利关系**，让城市展览在长期留存群众创作时，不因为素材受欢迎就跳过寄送人、图案作者、合影人物与各展出场地方之间的权利边界。

- `npm test`：19 项权利规则测试
- `node src/scenario.js`：一面旗帜从征集、确认、展出、撤回、争议到借展的完整过程记录

## 权利模型

每条素材的权利事实分成五条相互独立的链，任何一条未确认，素材都只能**内部保存**（员工可见完整记录，公众不可见）：

| 链 | 记录内容 | 服务方法 |
| --- | --- | --- |
| 实物保管 | 实物保管位置、移交责任、跨场地借展与归还 | `transferCustody` / `setStorageLocation` / `loanOut` / `returnLoan` |
| 数字来源 | 数字文件指纹；**重复上传按指纹归并到同一来源链**，不产生新素材 | `uploadFile` |
| 作者声明 | 寄送人只能声明为 `collector`；图案必须另有 `author` 声明；不同认领人互斥即构成冲突 | `declareAuthorship` |
| 人物同意 | 合影中可识别人物的同意；**未成年人必须登记监护人且同意只能由监护人作出**，可撤回 | `addPerson` / `grantPersonConsent` / `revokePersonConsent` |
| 展示许可 | 体育场 / 街区 / 临展的每次引用都绑定**用途与期限**，许可由权利专员授予 | `grantPermission` / `createReference` |

### 关键规则

- **统一收敛**：所有入口（`stadium`、`street_block`、`popup_exhibition`、员工台、公众页）都通过同一个 `canDisplay(itemId, { venueType, use, at })` 判定，得到同一份权利状态，不会出现一个入口放行、另一个入口泄露的情况。
- **撤回与既往展出**：作者撤回某一种使用后，该用途立即停止新的传播（进行中的引用标记 `haltedAt`），但既往引用、许可与活动记录完整保留，供合法展出核查。
- **衍生版本独立**：社区编辑的裁切（crop）、配音（dub）、翻译（translate）、主题故事（story）生成独立素材（`createDerivative`），作者归属为编辑者；展示时沿来源链继承原作品许可，原作品撤回或冻结会同步传导（含判定缓存失效）。
- **争议冻结**：`raiseDispute` 或作者认领冲突出现时，立即冻结全部传播，并保存冻结时点的完整状态快照（`getSnapshot`）；冻结期间不能制作衍生版本。**只有权利专员（rights_officer）能作处理决定**（`resolveDispute`）。
- **许可缓存**：`canDisplay` 的判定缓存同时受 TTL 与所依据许可到期时间约束，取更早者失效；撤回、冲突、裁决、借展等事件会使素材及其衍生版本的缓存级联失效。许可一旦过期，所有入口一致转为拒绝。
- **两套视图**：`staffView` 向馆藏人员提供完整来历、保管位置、借展与权利记录（含内部素材）；`publicView` 只返回获准公开的来历（作者署名 + 当期展示信息），不暴露保管位置、人物身份、收藏者、争议，也不暴露未授权素材是否存在。

## 目录

```
src/memory-service.js  权利服务核心（五条链 + 收敛判定 + 视图）
src/scenario.js        端到端场景：湘超冠军旗的完整权利生命周期
src/seed.js            领域样例读取
fixtures/seed.json     样例数据
test/                  node:test 测试
```

## 最小用法

```js
import { MemoryService } from "./src/memory-service.js";

const service = new MemoryService();
const officer = { id: "r1", role: "rights_officer" };

service.registerItem({ id: "flag-1", fingerprint: "sha256:abc" });
service.declareAuthorship({ id: "sender" }, "flag-1", {
  claimantId: "sender", name: "老李", role: "collector",
});
// 此时 getRightsState("flag-1").status === "unverified"，公众不可见

service.declareAuthorship({ id: "designer" }, "flag-1", {
  claimantId: "designer", name: "阿琳", role: "author", evidence: "设计原稿",
});
service.grantPermission(officer, "flag-1", {
  venueType: "stadium", use: "现场展示",
  startAt: "2026-06-01T00:00:00+08:00",
  endAt: "2026-07-31T23:59:59+08:00",
});

service.canDisplay("flag-1", { venueType: "stadium", use: "现场展示", at: "2026-07-01T00:00:00+08:00" });
// { allowed: true, permissionId: "perm-...", reasons: [] }
```
