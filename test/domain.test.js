import assert from "node:assert/strict";
import test from "node:test";

import { LicenseCache, Registry, fingerprintOf, publicView, staffView } from "../src/domain.js";
import { OFFICER, VENUES, advanceScenario, buildScenario } from "../src/scenario.js";

const t = (day, hour = 9) => new Date(2026, 8, day, hour).toISOString();
const unauthorized = { id: "intern", role: "community_editor", name: "实习生" };

test("五类权利关系分开记录：保管位置、文件来源、作者声明、人物同意、展示许可", () => {
  const { registry } = buildScenario();
  const custody = registry.custody.get("flag-001");
  assert.equal(custody.location, VENUES.STADIUM);
  assert.ok(registry.chains.get(registry.items.get("flag-001").chainId).fingerprint);
  const claims = registry.claimsByItem.get("flag-001");
  assert.deepEqual(
    claims.map((c) => c.role).sort(),
    ["author", "collector"],
  );
  assert.equal(registry.consentsByItem.get("photo-002")[0].person.minor, true);
  assert.equal(registry.licensesByItem.get("flag-001"), undefined); // 许可另立、尚未发放
});

test("寄送人是收藏者、图案作者另有其人：收藏者声明不构成作者权", () => {
  const { registry } = advanceScenario(buildScenario());
  const status = registry.rightsStatus("flag-001", t(2));
  assert.equal(status.state, "public");
  assert.equal(status.acceptedAuthor.name, "陈画笔");
  const collectorClaim = registry.claims.get("claim-collector-1");
  assert.equal(collectorClaim.disposition, "rejected");
  assert.equal(collectorClaim.role, "collector");
});

test("重复上传按指纹归并到同一来源链", () => {
  const { registry } = buildScenario();
  const fp = registry.chains.get(registry.items.get("flag-001").chainId).fingerprint;
  const first = registry.attachFile("flag-001", { fileId: "dup-1", fingerprint: fp, uploadedBy: { name: "街区岗" } });
  const second = registry.attachFile("flag-001", { fileId: "dup-2", fingerprint: fp, uploadedBy: { name: "临展岗" } });
  assert.equal(first.chainId, second.chainId);
  assert.equal(registry.chains.size, 2); // 旗帜、合影各一条链，重复上传未新增
  assert.equal(registry.chains.get(first.chainId).files.length, 3);
});

test("家长未同意公开的未成年人合影只能内部保存，公众视图不可见", () => {
  const { registry } = advanceScenario(buildScenario());
  const status = registry.rightsStatus("photo-002", t(2));
  assert.equal(status.state, "internal_only");
  assert.ok(status.denyReasons.some((r) => r.includes("家长同意")));
  assert.equal(registry.canReference("photo-002", { purpose: "现场大屏展示", venue: VENUES.STADIUM }, t(2)).allowed, false);
  assert.ok(!publicView(registry, t(2)).some((entry) => entry.id === "photo-002"));
  // 馆藏人员仍可在内部视图看到全部记录
  assert.ok(staffView(registry, t(2)).some((entry) => entry.item.id === "photo-002"));
});

test("家长补签同意后合影可公开，撤回后再次回到内部保存", () => {
  const { registry } = advanceScenario(buildScenario());
  registry.recordConsent("photo-002", {
    consentId: "consent-kid-signed",
    person: { name: "小球迷", minor: true },
    guardian: { name: "小球迷家长", relation: "父亲" },
    granted: true,
  });
  registry.grantLicense("photo-002", {
    licenseId: "lic-photo",
    purpose: "现场大屏展示",
    venues: [VENUES.STADIUM],
    start: t(5),
    end: t(25),
  });
  assert.equal(registry.rightsStatus("photo-002", t(6)).state, "public");
  registry.withdrawConsent("consent-kid-signed");
  assert.equal(registry.rightsStatus("photo-002", t(7)).state, "internal_only");
});

test("每次引用都绑定用途与期限；无许可、超场地或超期限均拒绝", () => {
  const { registry } = advanceScenario(buildScenario());
  assert.equal(registry.canReference("flag-001", { purpose: "临展印制", venue: VENUES.STADIUM }, t(5)).allowed, false); // 许可只覆盖临展场地
  assert.equal(registry.canReference("flag-001", { purpose: "现场大屏展示", venue: VENUES.POPUP }, t(5)).allowed, false); // 临展不在大屏许可场地
  assert.equal(registry.canReference("flag-001", { purpose: "临展印制", venue: VENUES.POPUP }, t(25)).allowed, false); // 已过许可期限
  assert.throws(() => registry.createReference("flag-001", { venue: VENUES.STADIUM, purpose: "未知用途", start: t(2), end: t(9) }, t(2)), /引用被拒绝/);
});

test("作者撤回某一种使用后停止新传播，既往合法展出仍可核查", () => {
  const { registry } = advanceScenario(buildScenario());
  const before = registry.references.filter((ref) => ref.itemId === "flag-001");
  assert.equal(before.length, 2);
  const revoked = registry.revokeLicense("flag-001", "现场大屏展示", OFFICER);
  assert.ok(revoked >= 1);
  // 既往引用被标记停止而非删除，开始时间、许可号等留痕完整
  const historical = registry.references.filter((ref) => ref.itemId === "flag-001");
  assert.equal(historical.length, 2);
  assert.ok(historical.every((ref) => ref.status === "stopped" && ref.stopReason === "作者撤回该用途"));
  assert.ok(historical.every((ref) => ref.startedAt && ref.licenseId));
  // 停止新传播
  assert.equal(registry.canReference("flag-001", { purpose: "现场大屏展示", venue: VENUES.STADIUM }, t(10)).allowed, false);
  // 另一种用途许可不受影响
  assert.equal(registry.canReference("flag-001", { purpose: "临展印制", venue: VENUES.POPUP }, t(10)).allowed, true);
});

test("裁切、配音、翻译产生独立衍生版本，并独立记录权属状态", () => {
  const { registry } = advanceScenario(buildScenario());
  const crop = registry.items.get("flag-001-crop");
  assert.equal(crop.derivativeOf.sourceId, "flag-001");
  assert.equal(crop.derivativeOf.transform, "裁切");
  // 衍生版本是独立素材：没有自己的许可前不能引用，原素材许可不自动继承
  assert.equal(registry.canReference("flag-001-crop", { purpose: "现场大屏展示", venue: VENUES.STADIUM }, t(4)).allowed, false);
  // 衍生版本的权属（编辑者署名）也需独立确认
  registry.addClaim("flag-001-crop", { claimId: "claim-crop-editor", party: { name: "小林" }, role: "author", evidence: "编辑工程文件" });
  registry.resolveClaim("claim-crop-editor", { accept: true }, OFFICER);
  registry.grantLicense("flag-001-crop", {
    licenseId: "lic-crop",
    purpose: "现场大屏展示",
    venues: [VENUES.STADIUM],
    start: t(4),
    end: t(20),
  });
  assert.equal(registry.canReference("flag-001-crop", { purpose: "现场大屏展示", venue: VENUES.STADIUM }, t(5)).allowed, true);
});

test("争议出现后先冻结传播并保全当前状态，仅授权人员可处理", () => {
  const { registry } = advanceScenario(buildScenario());
  const dispute = registry.openDispute("flag-001", { disputeId: "disp-1", reason: "第三方主张旗面图案著作权" });
  assert.ok(dispute.snapshots[0].hash);
  const snapshotHash = dispute.snapshots[0].hash;
  // 冻结覆盖原素材与全部衍生版本
  for (const id of ["flag-001", "flag-001-crop", "flag-001-voice", "flag-001-en"]) {
    assert.equal(registry.rightsStatus(id, t(11)).state, "frozen");
    assert.equal(registry.canReference(id, { purpose: "现场大屏展示", venue: VENUES.STADIUM }, t(11)).allowed, false);
  }
  assert.throws(() => registry.resolveDispute("disp-1", { action: "维持内部保存", note: "证据不足" }, unauthorized), /只有获授权/);
  // 冻结期间再发生变化也不改变已保全的快照
  registry.grantLicense("flag-001-crop", { licenseId: "lic-crop-2", purpose: "街区灯箱", venues: [VENUES.STREET], start: t(11), end: t(12) });
  assert.equal(dispute.snapshots[0].hash, snapshotHash);
  const resolved = registry.resolveDispute("disp-1", { action: "维持原作者认领", note: "源文件证据成立" }, OFFICER);
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.resolution.decidedBy, OFFICER.id);
  assert.equal(registry.rightsStatus("flag-001", t(13)).state, "public");
});

test("馆藏人员完成实物移交与跨场地借展管理", () => {
  const { registry } = advanceScenario(buildScenario());
  registry.transferCustody("flag-001", { to: "市文化馆库房", custodian: "馆藏组 赵姐", reason: "临展集中保管" });
  assert.equal(registry.custody.get("flag-001").location, "市文化馆库房");
  assert.equal(registry.custody.get("flag-001").transfers.length, 1);
  const loan = registry.createLoan("flag-001", {
    loanId: "loan-1",
    borrower: "城市临展组委会",
    venues: [VENUES.STADIUM, VENUES.STREET, VENUES.POPUP],
    purpose: "湘超冠军城巡展",
    start: t(10),
    end: t(20),
  });
  assert.deepEqual(loan.venues.length, 3);
  assert.equal(registry.custody.get("flag-001").loans[0].loanId, "loan-1");
});

test("作者认领冲突时进入 contested，裁定前不能公开；裁定后收敛为 public", () => {
  const { registry } = buildScenario();
  registry.resolveClaim("claim-collector-1", { accept: false }, OFFICER);
  registry.resolveClaim("claim-author-1", { accept: true }, OFFICER);
  // 第二位“作者”出现并获受理 → 冲突
  registry.addClaim("flag-001", { claimId: "claim-author-2", party: { name: "吴设计" }, role: "author", evidence: "旧稿" });
  registry.resolveClaim("claim-author-2", { accept: true }, OFFICER);
  assert.equal(registry.rightsStatus("flag-001", t(3)).authorship, "contested");
  assert.equal(registry.rightsStatus("flag-001", t(3)).state, "contested");
  // 授权人员重新裁定：驳回后认领者
  registry.resolveClaim("claim-author-2", { accept: false }, OFFICER);
  const status = registry.rightsStatus("flag-001", t(4));
  assert.equal(status.authorship, "resolved");
  assert.equal(status.acceptedAuthor.name, "陈画笔");
});

test("许可缓存：体育场/街区/临展三入口共享同一权利状态，过期或变更后收敛", () => {
  const { registry } = advanceScenario(buildScenario());
  const stadiumCache = new LicenseCache(registry, { ttlMs: 60_000 });
  const streetCache = new LicenseCache(registry, { ttlMs: 60_000 });
  const popupCache = new LicenseCache(registry, { ttlMs: 60_000 });

  const ask = (cache, venue, purpose, day) => cache.resolve("flag-001", { purpose, venue }, t(day, 10)).allowed;
  assert.equal(ask(stadiumCache, VENUES.STADIUM, "现场大屏展示", 5), true);
  assert.equal(ask(streetCache, VENUES.STREET, "现场大屏展示", 5), true);
  assert.equal(ask(popupCache, VENUES.POPUP, "临展印制", 5), true);

  // 命中缓存
  assert.equal(stadiumCache.resolve("flag-001", { purpose: "现场大屏展示", venue: VENUES.STADIUM }, t(5, 10)).cached, true);

  // 撤回后权利版本号递增：即使 TTL 未到，各入口缓存立即失效并收敛为拒绝
  registry.revokeLicense("flag-001", "现场大屏展示", OFFICER);
  assert.equal(ask(stadiumCache, VENUES.STADIUM, "现场大屏展示", 5), false);
  assert.equal(ask(streetCache, VENUES.STREET, "现场大屏展示", 5), false);
  // 临展印制许可是另一用途，不受影响
  assert.equal(ask(popupCache, VENUES.POPUP, "临展印制", 5), true);

  // 许可到期（TTL 外重新评估）同样收敛：临展许可 9-20 到期
  assert.equal(ask(popupCache, VENUES.POPUP, "临展印制", 21), false);

  // 任何入口都不会借缓存吐出未授权内容
  const internal = new LicenseCache(registry);
  assert.equal(internal.resolve("photo-002", { purpose: "现场大屏展示", venue: VENUES.STADIUM }, t(5)).allowed, false);
});

test("权利状态版本号在任何权利变化时递增，支撑多入口一致收敛", () => {
  const { registry } = buildScenario();
  const v0 = registry.rightsVersion;
  registry.resolveClaim("claim-author-1", { accept: true }, OFFICER);
  assert.ok(registry.rightsVersion > v0);
  const v1 = registry.rightsVersion;
  registry.grantLicense("flag-001", { licenseId: "l", purpose: "展示", start: t(1), end: t(10) });
  assert.ok(registry.rightsVersion > v1);
});

test("公众视图只呈现获准公开的来历：标注作者、来源与有效许可", () => {
  const { registry } = advanceScenario(buildScenario());
  const pub = publicView(registry, t(5));
  const ids = pub.map((entry) => entry.id);
  assert.ok(ids.includes("flag-001"));
  // 衍生版本无自身作者认领，属未确认，不向公众泄露
  assert.ok(!ids.includes("flag-001-crop"));
  assert.ok(!ids.includes("photo-002"));
  const flag = pub.find((entry) => entry.id === "flag-001");
  assert.equal(flag.creditedAuthor, "陈画笔");
  assert.ok(flag.provenance.sourceChain.startsWith("chain-"));
  assert.ok(flag.licenses.some((license) => license.purpose === "临展印制"));
});

test("指纹为稳定标识：相同内容得到相同指纹", () => {
  assert.equal(fingerprintOf({ a: 1, b: 2 }), fingerprintOf({ b: 2, a: 1 }));
  assert.notEqual(fingerprintOf({ a: 1 }), fingerprintOf({ a: 2 }));
});
