// 球迷共创记忆服务——权利关系领域模型
// 五类权利关系分开记录：实物保管、数字来源链、作者声明、人物同意、展示许可。
// 权属裁定、用途期限引用、衍生版本、争议冻结、角色视图与许可缓存均在此收敛。

import { createHash } from "node:crypto";

const RIGHTS_OFFICER = "rights_officer"; // 获授权作权利处置决定的角色

export function fingerprintOf(value) {
  const canonical = JSON.stringify(value, Object.keys(value).sort());
  return createHash("sha256").update(canonical).digest("hex");
}

const toTime = (value) => (value instanceof Date ? value.getTime() : Date.parse(value));
const within = (at, start, end) => toTime(start) <= toTime(at) && toTime(at) <= toTime(end);

const requireRightsOfficer = (actor) => {
  if (!actor || actor.role !== RIGHTS_OFFICER) {
    throw new Error("只有获授权的权利管理人员能作处理决定");
  }
};

export class Registry {
  constructor({ now = () => new Date() } = {}) {
    this.now = now;
    this.items = new Map(); // itemId -> 素材（衍生版本也是独立 item）
    this.chains = new Map(); // chainId -> 数字来源链
    this.chainByFingerprint = new Map(); // fingerprint -> chainId（重复上传归并）
    this.custody = new Map(); // itemId -> 实物保管记录
    this.claims = new Map(); // claimId -> 作者/寄送声明
    this.claimsByItem = new Map();
    this.consents = new Map(); // consentId -> 人物同意
    this.consentsByItem = new Map();
    this.licenses = new Map(); // licenseId -> 展示许可
    this.licensesByItem = new Map();
    this.references = []; // 每次场地引用（用途+期限），长期留痕
    this.disputes = []; // 争议与冻结记录
    this.rightsVersion = 0; // 权利状态版本号，任何权利变化都递增
  }

  _bump() {
    this.rightsVersion += 1;
  }

  // ---------- 素材登记与数字来源链 ----------

  registerItem({ id, kind, title, fingerprint, uploadedBy = null, provenance = null, derivativeOf = null }) {
    if (this.items.has(id)) throw new Error(`素材标识重复：${id}`);
    const at = this.now().toISOString?.() ?? new Date(this.now()).toISOString();
    const item = { id, kind, title, derivativeOf, chainId: null, createdAt: at };
    this.items.set(id, item);
    if (fingerprint) this.attachFile(id, { fileId: `${id}:file:1`, fingerprint, uploadedBy, provenance });
    return item;
  }

  // 重复上传按指纹归并到同一来源链，不产生新链、不复制权属
  attachFile(itemId, { fileId, fingerprint, uploadedBy, provenance }) {
    const item = this._item(itemId);
    let chainId = this.chainByFingerprint.get(fingerprint);
    if (!chainId) {
      chainId = `chain-${fingerprint.slice(0, 12)}`;
      this.chains.set(chainId, { id: chainId, fingerprint, files: [], createdAt: new Date(this.now()).toISOString() });
      this.chainByFingerprint.set(fingerprint, chainId);
    }
    const at = new Date(this.now()).toISOString();
    this.chains.get(chainId).files.push({ fileId, uploadedBy, provenance, uploadedAt: at });
    if (!item.chainId) item.chainId = chainId;
    return { chainId, duplicate: this.chains.get(chainId).files.length > 1 };
  }

  // ---------- 实物保管、移交与借展 ----------

  recordCustody(itemId, { location, custodian }) {
    this._item(itemId);
    const at = new Date(this.now()).toISOString();
    this.custody.set(itemId, { itemId, location, custodian, since: at, transfers: [], loans: [] });
    return this.custody.get(itemId);
  }

  // 馆藏人员完成移交：保管责任在馆/街区之间流转，全程留痕
  transferCustody(itemId, { to, custodian, reason }) {
    const record = this._custody(itemId);
    const at = new Date(this.now()).toISOString();
    record.transfers.push({ from: record.location, to, custodian, reason, at });
    record.location = to;
    record.custodian = custodian;
    record.since = at;
    return record;
  }

  // 跨场地借展：一份借展协议可覆盖体育场、街区、临展多个场地
  createLoan(itemId, { loanId, borrower, venues, purpose, start, end }) {
    const record = this._custody(itemId);
    const loan = { loanId, borrower, venues: [...venues], purpose, start, end, status: "active" };
    record.loans.push(loan);
    return loan;
  }

  // ---------- 作者声明与认领冲突 ----------

  // role: author（图案作者）/ collector（寄送人、收藏者）——两者不是同一主体
  addClaim(itemId, { claimId, party, role, evidence = null }) {
    this._item(itemId);
    const claim = {
      id: claimId,
      itemId,
      party,
      role,
      evidence,
      disposition: "pending",
      declaredAt: new Date(this.now()).toISOString(),
    };
    this.claims.set(claimId, claim);
    (this.claimsByItem.get(itemId) ?? this.claimsByItem.set(itemId, []).get(itemId)).push(claim);
    this._bump();
    return claim;
  }

  // 认领裁定只有获授权人员能作出；accept=false 驳回，accept=true 确认为该素材作者
  resolveClaim(claimId, { accept }, actor) {
    requireRightsOfficer(actor);
    const claim = this.claims.get(claimId);
    if (!claim) throw new Error(`声明不存在：${claimId}`);
    claim.disposition = accept ? "accepted" : "rejected";
    claim.resolvedAt = new Date(this.now()).toISOString();
    claim.resolvedBy = actor.id;
    this._bump();
    return claim;
  }

  // ---------- 人物同意（含未成年人家长同意） ----------

  recordConsent(itemId, { consentId, person, guardian = null, granted, scope = ["公开传播"] }) {
    this._item(itemId);
    const consent = {
      id: consentId,
      itemId,
      person, // { name, minor }
      guardian, // 未成年人须为家长/监护人 { name, relation }
      granted,
      scope,
      grantedAt: granted ? new Date(this.now()).toISOString() : null,
      withdrawnAt: null,
    };
    this.consents.set(consentId, consent);
    (this.consentsByItem.get(itemId) ?? this.consentsByItem.set(itemId, []).get(itemId)).push(consent);
    this._bump();
    return consent;
  }

  withdrawConsent(consentId) {
    const consent = this.consents.get(consentId);
    if (!consent) throw new Error(`同意记录不存在：${consentId}`);
    consent.withdrawnAt = new Date(this.now()).toISOString();
    this._bump();
    return consent;
  }

  // ---------- 展示许可（用途 + 场地 + 期限） ----------

  grantLicense(itemId, { licenseId, purpose, venues = ["*"], start, end }) {
    const item = this._item(itemId);
    const license = {
      id: licenseId,
      itemId,
      purpose,
      venues: [...venues],
      validFrom: start,
      validUntil: end,
      status: "active",
      revokedAt: null,
    };
    this.licenses.set(licenseId, license);
    (this.licensesByItem.get(itemId) ?? this.licensesByItem.set(itemId, []).get(itemId)).push(license);
    this._bump();
    return license;
  }

  // 作者撤回某一种使用：该用途许可失效，停止新传播；既往引用留痕不删
  revokeLicense(itemId, purpose, actor) {
    requireRightsOfficer(actor);
    const at = new Date(this.now()).toISOString();
    let revoked = 0;
    for (const license of this.licensesByItem.get(itemId) ?? []) {
      if (license.purpose === purpose && license.status === "active") {
        license.status = "revoked";
        license.revokedAt = at;
        revoked += 1;
        for (const ref of this.references) {
          if (
            ref.itemId === itemId &&
            ref.purpose === purpose &&
            ref.status === "active" &&
            toTime(ref.period.end) >= toTime(at)
          ) {
            ref.status = "stopped";
            ref.stoppedAt = at;
            ref.stopReason = "作者撤回该用途";
          }
        }
      }
    }
    this._bump();
    return revoked;
  }

  // ---------- 场地引用（每次引用绑定用途与期限） ----------

  canReference(itemId, { purpose, venue }, at = this.now()) {
    const decision = this.rightsStatus(itemId, at);
    const license = (this.licensesByItem.get(itemId) ?? []).find(
      (entry) =>
        entry.status === "active" &&
        entry.purpose === purpose &&
        within(at, entry.validFrom, entry.validUntil) &&
        (entry.venues.includes("*") || entry.venues.includes(venue)),
    );
    if (!license) decision.denyReasons.push(`无覆盖「${purpose}@${venue}」且在有效期内的许可`);
    if (this._activeFreeze(itemId)) decision.denyReasons.push("争议处理中，传播已冻结");
    decision.allowed = decision.publiclyClear && Boolean(license) && !this._activeFreeze(itemId);
    decision.licenseId = license?.id ?? null;
    return decision;
  }

  // 引用成立时登记一条长期留痕记录；既往合法展出即使后来撤回/过期仍可核查
  createReference(itemId, { venue, purpose, start, end }, at = this.now()) {
    const check = this.canReference(itemId, { purpose, venue }, at);
    if (!check.allowed) throw new Error(`引用被拒绝：${check.denyReasons.join("；")}`);
    const ref = {
      id: `ref-${this.references.length + 1}`,
      itemId,
      venue,
      purpose,
      period: { start, end },
      licenseId: check.licenseId,
      status: "active",
      startedAt: new Date(at).toISOString(),
      stoppedAt: null,
      stopReason: null,
    };
    this.references.push(ref);
    return ref;
  }

  // ---------- 衍生版本（裁切、配音、翻译、主题故事均独立成件） ----------

  createDerivative(sourceId, { id, kind, title, transform, editor }) {
    this._item(sourceId);
    const item = this.registerItem({
      id,
      kind,
      title,
      derivativeOf: { sourceId, transform, editor },
    });
    return item;
  }

  // ---------- 争议：冻结传播并保全当前状态 ----------

  openDispute(rootItemId, { disputeId, reason }) {
    this._item(rootItemId);
    const at = new Date(this.now()).toISOString();
    // 保全：冻结时点与该素材及其衍生版本相关的全部权利记录快照
    const records = this._snapshotScope(rootItemId);
    const dispute = {
      id: disputeId,
      rootItemId,
      reason,
      status: "open",
      openedAt: at,
      snapshots: [{ at, records, hash: fingerprintOf(records) }],
      resolution: null,
    };
    this.disputes.push(dispute);
    this._bump();
    return dispute;
  }

  // 只有获授权人员能作处理决定（确认权利 / 驳回争议 / 维持内部保存）
  resolveDispute(disputeId, { action, note }, actor) {
    requireRightsOfficer(actor);
    const dispute = this.disputes.find((entry) => entry.id === disputeId);
    if (!dispute || dispute.status !== "open") throw new Error("没有可处理的进行中争议");
    // 处理决定作出前再保全一次，保证冻结期间状态变化可比对
    dispute.snapshots.push({
      at: new Date(this.now()).toISOString(),
      records: this._snapshotScope(dispute.rootItemId),
    });
    dispute.snapshots[dispute.snapshots.length - 1].hash = fingerprintOf(dispute.snapshots.at(-1).records);
    dispute.status = "resolved";
    dispute.resolution = { action, note, decidedBy: actor.id, at: new Date(this.now()).toISOString() };
    this._bump();
    return dispute;
  }

  // ---------- 权利状态裁定（所有入口共用的唯一口径） ----------

  rightsStatus(itemId, at = this.now()) {
    const item = this._item(itemId);
    const denyReasons = [];

    const authorClaims = (this.claimsByItem.get(itemId) ?? []).filter((claim) => claim.role === "author");
    const acceptedAuthors = authorClaims.filter((claim) => claim.disposition === "accepted");
    let authorship;
    if (acceptedAuthors.length > 1) {
      authorship = "contested";
      denyReasons.push("存在互相冲突的作者认领，等待裁定");
    } else if (acceptedAuthors.length === 1) {
      authorship = "resolved";
    } else if (authorClaims.some((claim) => claim.disposition === "pending")) {
      authorship = "pending";
      denyReasons.push("作者认领尚未确认");
    } else {
      authorship = "unclaimed";
      denyReasons.push("缺少作者声明");
    }

    const personBlocks = [];
    // 同一人物可能多次签署/撤回，以最新一条同意为准
    const latestByPerson = new Map();
    for (const consent of this.consentsByItem.get(itemId) ?? []) {
      latestByPerson.set(consent.person.name, consent);
    }
    for (const consent of latestByPerson.values()) {
      const effective = consent.granted && !consent.withdrawnAt;
      const guardianOk = !consent.person.minor || Boolean(consent.granted && consent.guardian);
      if (!effective || !guardianOk) {
        personBlocks.push(consent.person.minor ? `未成年人${consent.person.name}缺少有效家长同意` : `人物${consent.person.name}同意缺失或已撤回`);
      }
    }
    if (personBlocks.length) denyReasons.push(...personBlocks);

    const frozen = Boolean(this._activeFreeze(itemId));
    if (frozen) denyReasons.push("争议冻结中");

    const publiclyClear = authorship === "resolved" && personBlocks.length === 0;
    let state;
    if (frozen) state = "frozen";
    else if (authorship === "contested") state = "contested";
    else if (!publiclyClear) state = "internal_only";
    else state = "public";

    return {
      itemId,
      state,
      publiclyClear,
      authorship,
      acceptedAuthor: acceptedAuthors[0]?.party ?? null,
      personBlocks,
      frozen,
      denyReasons,
      rightsVersion: this.rightsVersion,
      at: new Date(at).toISOString(),
    };
  }

  // ---------- 内部辅助 ----------

  _item(itemId) {
    const item = this.items.get(itemId);
    if (!item) throw new Error(`素材不存在：${itemId}`);
    return item;
  }

  _custody(itemId) {
    const record = this.custody.get(itemId);
    if (!record) throw new Error(`素材无实物保管记录：${itemId}`);
    return record;
  }

  _activeFreeze(itemId) {
    // 争议冻结覆盖素材本身及其全部衍生版本
    return this.disputes.find(
      (dispute) =>
        dispute.status === "open" &&
        (dispute.rootItemId === itemId || this._derivesFrom(itemId, dispute.rootItemId)),
    );
  }

  _derivesFrom(itemId, rootId) {
    let item = this.items.get(itemId);
    while (item?.derivativeOf) {
      if (item.derivativeOf.sourceId === rootId) return true;
      item = this.items.get(item.derivativeOf.sourceId);
    }
    return false;
  }

  _snapshotScope(rootItemId) {
    const ids = [rootItemId, ...[...this.items.values()].filter((i) => this._derivesFrom(i.id, rootItemId)).map((i) => i.id)];
    return {
      items: ids.map((id) => this.items.get(id)),
      chains: [...new Set(ids.map((id) => this.items.get(id).chainId).filter(Boolean))].map((chainId) =>
        this.chains.get(chainId),
      ),
      custody: ids.map((id) => this.custody.get(id)).filter(Boolean),
      claims: [...this.claims.values()].filter((claim) => ids.includes(claim.itemId)),
      consents: [...this.consents.values()].filter((consent) => ids.includes(consent.itemId)),
      licenses: [...this.licenses.values()].filter((license) => ids.includes(license.itemId)),
      references: this.references.filter((ref) => ids.includes(ref.itemId)),
    };
  }
}

// ---------- 角色视图：馆藏全量 / 公众仅见获准公开的来历 ----------

export function staffView(registry, at = registry.now()) {
  return [...registry.items.keys()].map((itemId) => ({
    item: registry.items.get(itemId),
    rights: registry.rightsStatus(itemId, at),
    custody: registry.custody.get(itemId) ?? null,
    claims: registry.claimsByItem.get(itemId) ?? [],
    consents: registry.consentsByItem.get(itemId) ?? [],
    licenses: registry.licensesByItem.get(itemId) ?? [],
  }));
}

// 未确认/冻结/内部内容直接不出现在公众视图，避免泄露其存在
export function publicView(registry, at = registry.now()) {
  const visible = [];
  for (const itemId of registry.items.keys()) {
    const status = registry.rightsStatus(itemId, at);
    if (status.state !== "public") continue;
    const item = registry.items.get(itemId);
    const chain = registry.chains.get(item.chainId);
    visible.push({
      id: item.id,
      kind: item.kind,
      title: item.title,
      provenance: {
        sourceChain: chain.id,
        firstUploadedAt: chain.files[0]?.uploadedAt ?? null,
        firstUploadedBy: chain.files[0]?.uploadedBy ?? null,
      },
      creditedAuthor: status.acceptedAuthor?.name ?? null,
      licenses: (registry.licensesByItem.get(itemId) ?? [])
        .filter((license) => license.status === "active" && toTime(license.validUntil) >= toTime(at))
        .map((license) => ({ purpose: license.purpose, venues: license.venues, validUntil: license.validUntil })),
      derivativeOf: item.derivativeOf?.sourceId ?? null,
    });
  }
  return visible;
}

// ---------- 许可缓存：版本号 + TTL 双重收敛，三入口共享 ----------

export class LicenseCache {
  constructor(registry, { ttlMs = 60_000 } = {}) {
    this.registry = registry;
    this.ttlMs = ttlMs;
    this.entries = new Map(); // `${itemId}|${purpose}|${venue}` -> 决策缓存
  }

  resolve(itemId, { purpose, venue }, at = new Date()) {
    const key = `${itemId}|${purpose}|${venue}`;
    const cached = this.entries.get(key);
    const fresh =
      cached &&
      cached.rightsVersion === this.registry.rightsVersion &&
      toTime(at) - toTime(cached.resolvedAt) < this.ttlMs;
    if (fresh) return { ...cached.decision, cached: true };

    const decision = this.registry.canReference(itemId, { purpose, venue }, at);
    this.entries.set(key, { rightsVersion: this.registry.rightsVersion, resolvedAt: new Date(at).toISOString(), decision });
    return { ...decision, cached: false };
  }
}
