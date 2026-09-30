import assert from "node:assert/strict";
import test from "node:test";

import {
  MemoryService,
  DecisionCache,
  RightsError,
  AuthorizationError,
  VENUE_TYPES,
  TRANSFORMS,
} from "../src/memory-service.js";

const curator = { id: "c1", name: "馆藏员", role: "curator" };
const officer = { id: "r1", name: "权利专员", role: "rights_officer" };
const other = { id: "x1", name: "其他人员", role: "volunteer" };
const sender = { id: "s1", name: "寄送人老李" };
const author = { id: "a1", name: "作者阿琳" };

const T0 = "2026-06-01T00:00:00+08:00";
const T1 = "2026-07-31T23:59:59+08:00";
const MID = "2026-07-01T12:00:00+08:00";

function newService() {
  return new MemoryService({ now: () => new Date("2026-05-01T00:00:00+08:00") });
}

// 建立一条已完成全部权利确认的旗帜素材
function clearedFlag(service, id = "flag-1") {
  service.registerItem({
    id,
    title: "冠军旗",
    uploadedBy: sender.id,
    fingerprint: `sha256:${id}`,
    at: "2026-05-01T00:00:00+08:00",
  });
  service.transferCustody(curator, id, { toCustodian: "民俗库房", at: "2026-05-02T00:00:00+08:00" });
  service.declareAuthorship({ id: sender.id }, id, {
    claimantId: sender.id, name: "老李", role: "collector", at: "2026-05-03T00:00:00+08:00",
  });
  service.declareAuthorship({ id: author.id }, id, {
    claimantId: author.id, name: "阿琳", role: "author", evidence: "设计原稿", at: "2026-05-04T00:00:00+08:00",
  });
  service.addPerson({ id: "staff" }, id, {
    personId: "kid", name: "小球迷", minor: true,
    guardian: { guardianId: "mom", name: "王芳" }, at: "2026-05-05T00:00:00+08:00",
  });
  service.grantPersonConsent({ id: "mom" }, id, "kid", { grantedBy: "mom", at: "2026-05-06T00:00:00+08:00" });
  return id;
}

function grantAllVenues(service, id, use = "现场展示") {
  for (const venueType of VENUE_TYPES) {
    service.grantPermission(officer, id, { venueType, use, startAt: T0, endAt: T1 });
  }
}

// ---- 五条权利链：未确认只能内部保存 ---------------------------------------

test("寄送人自称收藏者时，作者未确认的素材只能内部保存", () => {
  const service = newService();
  service.registerItem({ id: "f", uploadedBy: sender.id, fingerprint: "sha256:f" });
  service.declareAuthorship({ id: sender.id }, "f", {
    claimantId: sender.id, name: "老李", role: "collector",
  });

  const state = service.getRightsState("f");
  assert.equal(state.status, "unverified");
  assert.equal(state.internalOnly, true);
  assert.equal(service.publicView("f"), null); // 公众完全不可见
  assert.ok(service.staffView("f")); // 员工仍可在内部看到完整记录
  assert.throws(
    () => service.createReference({ id: "ops" }, "f", { venueType: "stadium", use: "现场展示", startAt: T0, endAt: T1 }),
    RightsError,
  );
});

test("五条链齐备后状态为 cleared，三场地均可在期限内展示", () => {
  const service = newService();
  const id = clearedFlag(service);
  grantAllVenues(service, id);

  assert.equal(service.getRightsState(id).status, "cleared");
  for (const venueType of VENUE_TYPES) {
    const decision = service.canDisplay(id, { venueType, use: "现场展示", at: MID });
    assert.equal(decision.allowed, true, venueType);
  }
  assert.equal(
    service.canDisplay(id, { venueType: "stadium", use: "现场展示", at: "2026-05-31T23:59:59+08:00" }).allowed,
    false,
    "许可开始前不能展示",
  );
  assert.equal(
    service.canDisplay(id, { venueType: "stadium", use: "现场展示", at: "2026-08-01T00:00:00+08:00" }).allowed,
    false,
    "许可到期后不能展示",
  );
});

// ---- 数字文件来源链归并 ---------------------------------------------------

test("重复上传按指纹归并到同一来源链，不产生新素材", () => {
  const service = newService();
  service.registerItem({ id: "f", fingerprint: "sha256:same" });
  const second = service.uploadFile({ id: "popup" }, "f", { fingerprint: "sha256:same", uri: "copy.tif" });
  const third = service.uploadFile({ id: "other-venue" }, "f", { fingerprint: "sha256:same" });

  assert.equal(second.merged, true);
  assert.equal(third.sourceId, second.sourceId);
  const item = service.staffView("f");
  assert.deepEqual(item.sourceChain.fingerprints, ["sha256:same"]); // 同一指纹只挂一次
  assert.equal(item.sourceChain.sourceIds.length, 1);
});

test("同指纹文件登记在另一素材上时挂回同一条来源链", () => {
  const service = newService();
  service.registerItem({ id: "f1", fingerprint: "sha256:shared" });
  service.registerItem({ id: "f2", fingerprint: "sha256:other" });
  const linked = service.uploadFile({ id: "u" }, "f2", { fingerprint: "sha256:shared" });
  assert.equal(linked.merged, true);
  assert.deepEqual(service.staffView("f2").sourceChain.fingerprints, ["sha256:other", "sha256:shared"]);
});

// ---- 人物同意：未成年人监护人 ---------------------------------------------

test("未成年人缺少监护人登记时拒绝入库", () => {
  const service = newService();
  service.registerItem({ id: "f", fingerprint: "sha256:f" });
  assert.throws(
    () => service.addPerson({ id: "s" }, "f", { personId: "kid", name: "小球迷", minor: true }),
    RightsError,
  );
});

test("未成年人的同意只能由监护人作出", () => {
  const service = newService();
  service.registerItem({ id: "f", fingerprint: "sha256:f" });
  service.addPerson({ id: "s" }, "f", {
    personId: "kid", name: "小球迷", minor: true, guardian: { guardianId: "mom", name: "王芳" },
  });
  assert.throws(
    () => service.grantPersonConsent({ id: "kid" }, "f", "kid", { grantedBy: "kid" }),
    RightsError,
  );
  service.grantPersonConsent({ id: "mom" }, "f", "kid", { grantedBy: "mom" });
  const person = service.staffView("f").persons[0];
  assert.equal(person.consents.length, 1);
});

test("监护人撤回同意后所有入口停止传播", () => {
  const service = newService();
  const id = clearedFlag(service);
  grantAllVenues(service, id);
  service.createReference({ id: "ops" }, id, { venueType: "stadium", use: "现场展示", startAt: T0, endAt: T1 });

  service.revokePersonConsent({ id: "mom" }, id, "kid", { at: MID });
  assert.equal(service.canDisplay(id, { venueType: "stadium", use: "现场展示", at: MID }).allowed, false);
  assert.equal(service.publicView(id, { venueType: "stadium", use: "现场展示", at: MID }), null);
  const reference = service.staffView(id).references[0];
  assert.equal(reference.haltedAt, MID, "进行中的引用被中止");
});

// ---- 展示许可、引用与撤回 -------------------------------------------------

test("只有权利专员能授予许可，许可必须带场地用途与期限", () => {
  const service = newService();
  const id = clearedFlag(service);
  assert.throws(
    () => service.grantPermission(curator, id, { venueType: "stadium", use: "现场展示", startAt: T0, endAt: T1 }),
    AuthorizationError,
  );
  assert.throws(
    () => service.grantPermission(officer, id, { venueType: "stadium", use: "x", startAt: T1, endAt: T0 }),
    RightsError,
  );
});

test("引用绑定用途与期限，超出许可有效期的引用被拒绝", () => {
  const service = newService();
  const id = clearedFlag(service);
  service.grantPermission(officer, id, { venueType: "stadium", use: "现场展示", startAt: T0, endAt: T1 });

  const reference = service.createReference({ id: "ops" }, id, {
    venueType: "stadium", use: "现场展示", startAt: T0, endAt: T1,
  });
  assert.ok(reference.permissionId);
  assert.throws(
    () =>
      service.createReference({ id: "ops" }, id, {
        venueType: "stadium",
        use: "现场展示",
        startAt: T0,
        endAt: "2026-08-31T23:59:59+08:00", // 超出许可
      }),
    RightsError,
  );
});

test("作者撤回某一用途后停止新传播，其他用途不受影响，既往引用留痕可核查", () => {
  const service = newService();
  const id = clearedFlag(service);
  service.grantPermission(officer, id, { venueType: "stadium", use: "现场展示", startAt: T0, endAt: T1 });
  service.grantPermission(officer, id, { venueType: "street_block", use: "街区展陈", startAt: T0, endAt: T1 });
  service.createReference({ id: "ops" }, id, { venueType: "stadium", use: "现场展示", startAt: T0, endAt: T1 });
  service.createReference({ id: "ops" }, id, { venueType: "street_block", use: "街区展陈", startAt: T0, endAt: T1 });

  service.revokeUse(officer, id, { use: "街区展陈", at: MID });

  assert.equal(service.canDisplay(id, { venueType: "stadium", use: "现场展示", at: MID }).allowed, true);
  assert.equal(service.canDisplay(id, { venueType: "street_block", use: "街区展陈", at: MID }).allowed, false);
  assert.throws(
    () =>
      service.createReference({ id: "ops" }, id, {
        venueType: "street_block", use: "街区展陈",
        startAt: "2026-07-02T00:00:00+08:00", endAt: "2026-07-10T00:00:00+08:00",
      }),
    RightsError,
  );
  const staff = service.staffView(id);
  const streetRef = staff.references.find((r) => r.venueType === "street_block");
  assert.equal(streetRef.haltedAt, MID, "既往街区引用标记中止但记录保留");
  assert.ok(staff.history.some((event) => event.type === "reference_created" && event.venueType === "street_block"));
  assert.equal(service.getRightsState(id).status, "restricted");
});

// ---- 衍生版本 -------------------------------------------------------------

test("裁切/配音/翻译/主题故事产生独立衍生版本，并沿来源链继承许可", () => {
  const service = newService();
  const id = clearedFlag(service);
  service.grantPermission(officer, id, { venueType: "street_block", use: "街区展陈", startAt: T0, endAt: T1 });

  for (const transform of TRANSFORMS) {
    const derivativeId = `derivative-${transform}`;
    service.createDerivative({ id: "editor-1", name: "小满" }, id, { id: derivativeId, transform });
    const view = service.staffView(derivativeId);
    assert.equal(view.kind, "derivative");
    assert.equal(view.derivedFrom.itemId, id);
    assert.equal(view.derivedFrom.transform, transform);
    assert.ok(service.canDisplay(derivativeId, { venueType: "street_block", use: "街区展陈", at: MID }).allowed);
  }
  assert.throws(
    () => service.createDerivative({ id: "e" }, id, { id: "bad", transform: "deepfake" }),
    RightsError,
  );
});

test("原素材撤回用途时，衍生版本在该用途上同步停止传播（含缓存失效）", () => {
  let clock = new Date("2026-05-01T00:00:00+08:00").getTime();
  const service = new MemoryService({ now: () => new Date(clock), cacheTtlMs: 3_600_000 });
  const id = clearedFlag(service);
  service.grantPermission(officer, id, { venueType: "street_block", use: "街区展陈", startAt: T0, endAt: T1 });
  service.createDerivative({ id: "editor-1" }, id, { id: "story-1", transform: "story" });

  // 先产生缓存的放行结论
  assert.equal(service.canDisplay("story-1", { venueType: "street_block", use: "街区展陈", at: MID }).allowed, true);
  service.revokeUse(officer, id, { use: "街区展陈", at: MID });
  assert.equal(
    service.canDisplay("story-1", { venueType: "street_block", use: "街区展陈", at: MID }).allowed,
    false,
    "衍生版本的旧缓存必须随原素材撤回而失效",
  );
});

// ---- 争议冻结与快照、授权裁决 ---------------------------------------------

test("争议出现后冻结全部传播并保全状态快照，只有权利专员能裁决", () => {
  const service = newService();
  const id = clearedFlag(service);
  grantAllVenues(service, id);

  service.raiseDispute({ id: "reporter" }, id, { reason: "image_misattributed", at: MID });
  for (const venueType of VENUE_TYPES) {
    assert.equal(service.canDisplay(id, { venueType, use: "现场展示", at: MID }).allowed, false);
  }
  assert.equal(service.publicView(id, { venueType: "stadium", use: "现场展示", at: MID }), null);

  const snapshot = service.getSnapshot(id);
  assert.equal(snapshot.frozen, null, "快照是冻结发生前一刻的状态");
  assert.ok(snapshot.history.some((event) => event.type === "permission_granted"));
  assert.throws(() => service.createDerivative({ id: "e" }, id, { id: "d", transform: "crop" }), RightsError);

  assert.throws(
    () => service.resolveDispute(curator, id, { decision: { type: "reject" } }),
    AuthorizationError,
  );
  assert.throws(
    () => service.resolveDispute(other, id, { decision: { type: "reject" } }),
    AuthorizationError,
  );
  service.resolveDispute(officer, id, { decision: { type: "reject" }, note: "误报" });
  // 争议被驳回且作者声明确认，恢复展出
  service.declareAuthorship({ id: author.id }, id, {
    claimantId: author.id, name: "阿琳", role: "author", at: "2026-05-04T00:00:00+08:00",
  });
  assert.equal(service.canDisplay(id, { venueType: "stadium", use: "现场展示", at: MID }).allowed, true);
});

test("作者认领冲突自动冻结，裁决确认唯一作者后收敛", () => {
  const service = newService();
  const id = clearedFlag(service);
  grantAllVenues(service, id);

  service.declareAuthorship({ id: "rival" }, id, {
    claimantId: "rival", name: "另一人", role: "author", evidence: "草图", at: MID,
  });
  assert.equal(service.getRightsState(id).status, "frozen");

  const rivalClaim = service.staffView(id).authorship.claims.find((c) => c.claimantId === "rival");
  assert.throws(
    () => service.resolveDispute(officer, id, { decision: { type: "accept", claimId: "unknown" } }),
    RightsError,
  );
  service.resolveDispute(officer, id, { decision: { type: "accept", claimId: rivalClaim.id } });
  const state = service.getRightsState(id);
  assert.equal(state.status, "cleared");
  assert.deepEqual(
    service.staffView(id).authorship.claims
      .filter((c) => service.staffView(id).authorship.acceptedClaimIds.includes(c.id))
      .map((c) => c.claimantId),
    ["rival"],
  );
});

// ---- 移交与借展 -----------------------------------------------------------

test("馆藏人员完成实物移交、登记位置并办理跨场地借展归还", () => {
  const service = newService();
  service.registerItem({ id: "f", fingerprint: "sha256:f" });

  assert.throws(
    () => service.transferCustody(other, "f", { toCustodian: "库房" }),
    AuthorizationError,
  );
  service.transferCustody(curator, "f", { toCustodian: "市博物馆", at: T0 });
  service.setStorageLocation(curator, "f", { location: "库房 A-12", at: T0 });

  const loan = service.loanOut(curator, "f", {
    toVenue: "popup_exhibition",
    startAt: "2026-06-10T00:00:00+08:00",
    endAt: "2026-06-20T00:00:00+08:00",
    at: "2026-06-09T00:00:00+08:00",
  });
  assert.ok(loan.id);
  assert.throws(
    () => service.loanOut(curator, "f", { toVenue: "stadium", startAt: T0, endAt: T1 }),
    RightsError,
    "借展未归还不能重复出借",
  );
  service.returnLoan(curator, "f", { at: "2026-06-21T00:00:00+08:00" });
  const staff = service.staffView("f");
  assert.equal(staff.loans[0].returnedAt, "2026-06-21T00:00:00+08:00");
  assert.equal(staff.storageLocation.location, "库房 A-12");
  assert.equal(staff.custody.current, "市博物馆");
  // 保管位置与借展信息不进入公众视图
  assert.equal("storageLocation" in service.staffView("f"), true);
});

// ---- 许可缓存到期 ---------------------------------------------------------

test("判定缓存 TTL 到期失效，且缓存存活时间不超过所依据许可的到期时间", () => {
  let clock = 1_000_000;
  const cache = new DecisionCache(60_000);
  cache.set("k", { allowed: true }, clock, 1_030_000); // 许可 30 秒后到期
  assert.deepEqual(cache.get("k", 1_020_000), { allowed: true });
  assert.equal(cache.get("k", 1_031_000), null, "许可到期即驱逐，即使 TTL 未满");

  const cache2 = new DecisionCache(10_000);
  cache2.set("k2", { allowed: true }, clock, null);
  assert.ok(cache2.get("k2", 1_005_000));
  assert.equal(cache2.get("k2", 1_020_000), null, "TTL 到期失效");
});

test("跨场地借展、撤回、冲突等事件在所有入口按同一状态收敛", async () => {
  const service = newService();
  const id = clearedFlag(service);
  grantAllVenues(service, id);

  const entries = () =>
    VENUE_TYPES.map((venueType) =>
      service.canDisplay(id, { venueType, use: "现场展示", at: MID }).allowed,
    );

  assert.deepEqual(entries(), [true, true, true]);
  service.raiseDispute({ id: "p" }, id, { reason: "other", at: MID });
  assert.deepEqual(entries(), [false, false, false], "冻结对所有入口一致");
  service.resolveDispute(officer, id, { decision: { type: "reject" } });
  service.declareAuthorship({ id: author.id }, id, {
    claimantId: author.id, name: "阿琳", role: "author", at: "2026-05-04T00:00:00+08:00",
  });
  assert.deepEqual(entries(), [true, true, true], "裁决后所有入口一致恢复");
});

// ---- 公众/员工视图 --------------------------------------------------------

test("公众只看到获准公开的来历，看不到保管、人物、收藏者与争议细节", () => {
  const service = newService();
  const id = clearedFlag(service);
  grantAllVenues(service, id);

  const pub = service.publicView(id, { venueType: "stadium", use: "现场展示", at: MID });
  assert.deepEqual(Object.keys(pub).sort(), ["creditedAuthors", "display", "id", "kind", "title"]);
  assert.deepEqual(pub.creditedAuthors, ["阿琳"]);
  assert.equal(pub.display.venueType, "stadium");
  assert.equal("persons" in pub, false);
  assert.equal("storageLocation" in pub, false);
  assert.equal("loans" in pub, false);
  assert.equal("disputes" in pub, false);

  // 未登记素材也不向公众暴露存在性
  assert.equal(service.publicView("does-not-exist"), null);
});
