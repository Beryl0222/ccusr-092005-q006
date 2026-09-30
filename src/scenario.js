// 端到端场景：球迷旗帜「湘超冠军旗」在体育场、街区、临展之间的权利全生命周期。
// 运行：node src/scenario.js  （输出中文过程记录）

import { MemoryService, RightsError, AuthorizationError } from "./memory-service.js";

const curator = { id: "u-curator-01", name: "馆藏员周老师", role: "curator" };
const officer = { id: "u-rights-01", name: "权利专员郑敏", role: "rights_officer" };
const sender = { id: "p-laoli", name: "老李" }; // 寄送人 / 收藏者
const designer = { id: "p-alin", name: "阿琳" }; // 图案作者
const editor = { id: "u-editor-07", name: "社区编辑小满" };

export function buildScenario() {
  const log = [];
  const say = (step, detail) => log.push({ step, detail });

  const service = new MemoryService({ now: () => new Date("2026-05-10T09:00:00+08:00"), cacheTtlMs: 60_000 });

  // 1) 寄送人老李交来旗帜与合影；数字文件带有指纹
  service.registerItem({
    id: "flag-guest-042",
    kind: "fan_artifact",
    title: "湘超冠军旗",
    uploadedBy: sender.id,
    fingerprint: "sha256:flag042-original",
    uri: "ingest/2026/flag042.tif",
    at: "2026-05-10T09:00:00+08:00",
  });

  // 2) 实物保管：移交给馆藏方并登记库房位置
  service.transferCustody(curator, "flag-guest-042", {
    fromCustodian: sender.id,
    toCustodian: "市博物馆民俗库房",
    note: "城市展览征集",
    at: "2026-05-10T10:00:00+08:00",
  });
  service.setStorageLocation(curator, "flag-guest-042", {
    location: "民俗库房 A-12 旗柜",
    at: "2026-05-10T10:05:00+08:00",
  });

  // 3) 老李只声明自己是收藏者——寄送人不等于作者；此时作者未确认
  service.declareAuthorship(
    { id: sender.id },
    "flag-guest-042",
    { claimantId: sender.id, name: "老李", role: "collector", evidence: "寄送登记单", at: "2026-05-12T09:00:00+08:00" },
  );
  say("权利未确认（只有收藏者声明）", service.getRightsState("flag-guest-042", { at: "2026-05-12T09:00:00+08:00" }));

  // 4) 临展筹备处重复上传同一文件：按指纹归并到同一来源链
  const reup = service.uploadFile(
    { id: "u-popup-prep" },
    "flag-guest-042",
    { fingerprint: "sha256:flag042-original", uri: "popup-prep/flag042-copy.tif", at: "2026-05-13T14:00:00+08:00" },
  );

  // 5) 合影中有名有姓的人物：一名未成年人（须监护人同意）、一名成年人
  service.addPerson({ id: "staff" }, "flag-guest-042", {
    personId: "p-kid", name: "小球迷", minor: true,
    guardian: { guardianId: "p-wangfang", name: "王芳（母亲）" },
    at: "2026-05-13T15:00:00+08:00",
  });
  service.addPerson({ id: "staff" }, "flag-guest-042", {
    personId: "p-awei", name: "阿伟", minor: false,
    at: "2026-05-13T15:05:00+08:00",
  });

  // 6) 图案作者阿琳出面声明；监护人王芳与阿伟分别给出同意
  service.declareAuthorship(
    { id: designer.id },
    "flag-guest-042",
    { claimantId: designer.id, name: "阿琳", role: "author", evidence: "设计原稿与图层文件", at: "2026-05-15T10:00:00+08:00" },
  );
  service.grantPersonConsent({ id: "p-wangfang" }, "flag-guest-042", "p-kid", {
    scope: "all", grantedBy: "p-wangfang", at: "2026-05-16T09:00:00+08:00",
  });
  service.grantPersonConsent({ id: "p-awei" }, "flag-guest-042", "p-awei", {
    scope: "all", at: "2026-05-16T09:30:00+08:00",
  });

  // 7) 权利专员按场地 + 用途 + 期限授予展示许可
  const window = { startAt: "2026-06-01T00:00:00+08:00", endAt: "2026-07-31T23:59:59+08:00" };
  for (const [venueType, use] of [
    ["stadium", "现场展示"],
    ["street_block", "街区主题展陈"],
    ["popup_exhibition", "临展陈列"],
  ]) {
    service.grantPermission(officer, "flag-guest-042", { venueType, use, ...window });
  }

  // 8) 三类场地各自创建引用，引用绑定用途与期限（且不超出许可期限）
  for (const [venueType, use] of [
    ["stadium", "现场展示"],
    ["street_block", "街区主题展陈"],
    ["popup_exhibition", "临展陈列"],
  ]) {
    service.createReference({ id: "venue-ops" }, "flag-guest-042", {
      venueType, use,
      startAt: "2026-06-01T00:00:00+08:00",
      endAt: "2026-07-31T23:59:59+08:00",
      at: "2026-05-20T11:00:00+08:00",
    });
  }

  // 9) 社区编辑制作独立衍生版本：主题故事与裁切图（各自独立素材，沿来源链继承许可）
  service.createDerivative(editor, "flag-guest-042", {
    id: "story-042-v1", transform: "story", title: "冠军城里的一面旗",
    use: "主题故事", venueType: "street_block",
    startAt: "2026-06-01T00:00:00+08:00", endAt: "2026-07-31T23:59:59+08:00",
    at: "2026-05-22T10:00:00+08:00",
  });
  service.createDerivative(editor, "flag-guest-042", {
    id: "crop-042-square", transform: "crop", title: "旗帜方形裁切",
    at: "2026-05-22T10:30:00+08:00",
  });

  // 10) 跨场地借展：实物从库房借到临展，按期归还
  const loan = service.loanOut(curator, "flag-guest-042", {
    toVenue: "popup_exhibition",
    startAt: "2026-06-10T00:00:00+08:00",
    endAt: "2026-06-20T23:59:59+08:00",
    at: "2026-06-09T15:00:00+08:00",
  });
  service.returnLoan(curator, "flag-guest-042", { at: "2026-06-21T09:00:00+08:00" });

  const allowedBefore = {
    stadium: service.canDisplay("flag-guest-042", { venueType: "stadium", use: "现场展示", at: "2026-06-15T12:00:00+08:00" }).allowed,
    street: service.canDisplay("flag-guest-042", { venueType: "street_block", use: "街区主题展陈", at: "2026-06-15T12:00:00+08:00" }).allowed,
    popup: service.canDisplay("flag-guest-042", { venueType: "popup_exhibition", use: "临展陈列", at: "2026-06-15T12:00:00+08:00" }).allowed,
  };

  // 11) 2026-07-01 作者撤回「街区主题展陈」：停止新传播，既往引用留痕可核查
  service.revokeUse(officer, "flag-guest-042", {
    use: "街区主题展陈", reason: "作者不希望再用于街区商业布景",
    at: "2026-07-01T09:00:00+08:00",
  });
  let newStreetRefBlocked = false;
  try {
    service.createReference({ id: "venue-ops" }, "flag-guest-042", {
      venueType: "street_block", use: "街区主题展陈",
      startAt: "2026-07-02T00:00:00+08:00",
      endAt: "2026-07-10T23:59:59+08:00",
      at: "2026-07-01T10:00:00+08:00",
    });
  } catch (error) {
    if (error instanceof RightsError) newStreetRefBlocked = true;
  }
  const staff = service.staffView("flag-guest-042");
  const haltedStreetRef = staff.references.find((r) => r.venueType === "street_block");

  // 12) 作者认领冲突：另有一人声称自己是图案作者 → 全部入口立即冻结
  service.declareAuthorship(
    { id: "p-rival" },
    "flag-guest-042",
    { claimantId: "p-rival", name: "另一名认领者", role: "author", evidence: "网传草图", at: "2026-07-05T09:00:00+08:00" },
  );
  const frozenState = service.getRightsState("flag-guest-042", { at: "2026-07-05T09:01:00+08:00" });
  const frozenEntryChecks = {
    stadium: service.canDisplay("flag-guest-042", { venueType: "stadium", use: "现场展示", at: "2026-07-05T09:01:00+08:00" }),
    story: service.canDisplay("story-042-v1", { venueType: "street_block", use: "街区主题展陈", at: "2026-07-05T09:01:00+08:00" }),
  };
  const snapshot = service.getSnapshot("flag-guest-042");
  const snapshotDispute = snapshot.disputes.at(-1);

  // 非权利专员不能裁决
  let unauthorizedDecisionBlocked = false;
  try {
    service.resolveDispute(curator, "flag-guest-042", { decision: { type: "accept", claimId: "x" } });
  } catch (error) {
    if (error instanceof AuthorizationError) unauthorizedDecisionBlocked = true;
  }

  // 13) 权利专员核查后确认阿琳为作者，解除冻结；街区撤回仍然有效
  const openDisputeId = service.staffView("flag-guest-042").disputes.find((d) => !d.resolved).id;
  const alinClaimId = service
    .staffView("flag-guest-042")
    .authorship.claims.find((c) => c.claimantId === designer.id).id;
  service.resolveDispute(officer, "flag-guest-042", {
    decision: { type: "accept", claimId: alinClaimId },
    note: "图层原稿时间戳在先，草图证据不足",
    at: "2026-07-08T14:00:00+08:00",
  });

  const afterResolve = {
    stadium: service.canDisplay("flag-guest-042", { venueType: "stadium", use: "现场展示", at: "2026-07-09T12:00:00+08:00" }).allowed,
    street: service.canDisplay("flag-guest-042", { venueType: "street_block", use: "街区主题展陈", at: "2026-07-09T12:00:00+08:00" }).allowed,
  };

  // 14) 许可缓存到期收敛：许可 7 月 31 日结束，8 月 1 日所有入口都转为拒绝
  const afterLicenseExpiry = {
    stadium: service.canDisplay("flag-guest-042", { venueType: "stadium", use: "现场展示", at: "2026-08-01T08:00:00+08:00" }),
    popup: service.canDisplay("flag-guest-042", { venueType: "popup_exhibition", use: "临展陈列", at: "2026-08-01T08:00:00+08:00" }),
  };

  // 15) 员工与公众两种视图
  const staffFinal = service.staffView("flag-guest-042");
  const publicDuringLicense = service.publicView("flag-guest-042", {
    venueType: "stadium", use: "现场展示", at: "2026-06-15T12:00:00+08:00",
  });
  const publicAfterExpiry = service.publicView("flag-guest-042", {
    venueType: "stadium", use: "现场展示", at: "2026-08-01T08:00:00+08:00",
  });

  return {
    service,
    log,
    results: {
      reup,
      loan,
      allowedBefore,
      newStreetRefBlocked,
      haltedStreetRef,
      frozenState,
      frozenEntryChecks,
      snapshotSummary: { disputeId: snapshotDispute.id, frozenAt: snapshotDispute.at, historyEvents: snapshot.history.length },
      unauthorizedDecisionBlocked,
      openDisputeId,
      afterResolve,
      afterLicenseExpiry,
      staffFinal,
      publicDuringLicense,
      publicAfterExpiry,
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { results } = buildScenario();
  console.log(JSON.stringify(results, null, 2));
}
