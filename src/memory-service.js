// 球迷共创城市记忆——权利关系服务
//
// 一条素材的权利事实被拆成五条相互独立的链，任何一条未确认，素材都只能内部保存：
//   1. 实物保管链  custody      —— 旗帜实物在哪、移交给谁
//   2. 数字来源链  sourceChain  —— 数字文件从哪来，重复上传归并到同一链
//   3. 作者声明链  authorship   —— 寄送人可以是收藏者，但作者另有其人时必须由作者声明
//   4. 人物同意链  persons      —— 合影中可识别人物的同意；未成年人必须有监护人同意
//   5. 展示许可链  permissions  —— 每次引用绑定场地、用途与期限
//
// 所有入口（体育场 / 街区 / 临展 / 员工台 / 公众页）对同一条素材都通过同一个
// canDisplay 收敛到同一个权利状态；争议期间冻结传播并快照保全。

export class RightsError extends Error {}
export class AuthorizationError extends Error {}

export const VENUE_TYPES = Object.freeze(["stadium", "street_block", "popup_exhibition"]);
export const TRANSFORMS = Object.freeze(["crop", "dub", "translate", "story"]);

const STAFF_ROLES = new Set(["curator", "rights_officer"]);
const DECIDING_ROLES = new Set(["rights_officer"]);

const clone = (value) => structuredClone(value);

function requireActor(actor, allowed, action) {
  if (!actor || !allowed.has(actor.role)) {
    throw new AuthorizationError(`无权执行「${action}」`);
  }
}

// 展示判定缓存：TTL 到期或缓存所依据的许可到期（取更早者）都会失效，
// 因此不会在许可已过期时继续放出旧的放行结论。
export class DecisionCache {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.entries = new Map();
  }

  get(key, nowMs) {
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= nowMs) {
      if (entry) this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key, value, nowMs, limitAt) {
    const ttlAt = nowMs + this.ttlMs;
    this.entries.set(key, {
      value,
      expiresAt: limitAt ? Math.min(ttlAt, limitAt) : ttlAt,
    });
  }

  invalidateItem(itemId) {
    for (const key of this.entries.keys()) {
      if (key.startsWith(`${itemId}|`)) this.entries.delete(key);
    }
  }
}

export class MemoryService {
  constructor({ now = () => new Date(), cacheTtlMs = 60_000 } = {}) {
    this._now = now;
    this._items = new Map();
    this._sources = new Map(); // fingerprint -> sourceId，重复上传归并的依据
    this._cache = new DecisionCache(cacheTtlMs);
    this._seq = 0;
  }

  _at(at) {
    return at ?? this._now().toISOString();
  }

  _ms(at) {
    return new Date(at).getTime();
  }

  _item(id) {
    const item = this._items.get(id);
    if (!item) throw new RightsError(`素材不存在：${id}`);
    return item;
  }

  _oid(prefix) {
    this._seq += 1;
    return `${prefix}-${String(this._seq).padStart(4, "0")}`;
  }

  _log(item, event) {
    item.history.push({ at: this._at(event.at), ...event });
  }

  // 权利事实链是否齐备（与时间窗口无关；许可是否在有效期由 canDisplay 判定）
  _chainReady(item) {
    if (item.frozen || item.authorship.conflict) return false;
    const hasAuthor = item.authorship.claims.some(
      (claim) => claim.role === "author" && item.authorship.acceptedClaimIds.includes(claim.id),
    );
    if (!hasAuthor) return false;
    for (const person of item.persons) {
      if (person.minor && !person.guardian) return false;
      const activeConsent = person.consents.some((consent) => !consent.revokedAt);
      if (!activeConsent) return false;
    }
    if (item.derivedFrom) {
      const parent = this._items.get(item.derivedFrom.itemId);
      if (!parent || !this._chainReady(parent)) return false;
    }
    return true;
  }

  // ---- 素材登记 -----------------------------------------------------------

  registerItem({ id, kind = "fan_artifact", title = "", uploadedBy, fingerprint, uri, at }) {
    if (this._items.has(id)) throw new RightsError(`素材标识重复：${id}`);
    const item = {
      id,
      kind,
      title,
      custody: { current: null, history: [] },
      storageLocation: null,
      sourceChain: { sourceIds: [], fingerprints: [] },
      authorship: { claims: [], acceptedClaimIds: [], conflict: false },
      persons: [],
      permissions: [],
      useRevocations: [],
      references: [],
      loans: [],
      disputes: [],
      frozen: null,
      derivedFrom: null,
      derivativeIds: [],
      internal: true, // 权利未确认前一律内部保存
      history: [],
    };
    this._items.set(id, item);
    if (fingerprint) this._attachFingerprint(item, { fingerprint, uri, uploadedBy, at });
    this._log(item, { type: "registered", actorId: uploadedBy ?? null, at: this._at(at) });
    return clone(item);
  }

  // ---- 1. 实物保管 --------------------------------------------------------

  // 馆藏人员完成移交：实物保管责任从一方转到馆藏方
  transferCustody(actor, itemId, { toCustodian, note = "", at }) {
    requireActor(actor, STAFF_ROLES, "实物移交");
    const item = this._item(itemId);
    const entry = { from: item.custody.current, to: toCustodian, by: actor.id, at: this._at(at), note };
    item.custody.current = toCustodian;
    item.custody.history.push(entry);
    this._log(item, { type: "custody_transferred", ...entry });
    return clone(entry);
  }

  // 登记实物保管位置（库房 / 展柜）
  setStorageLocation(actor, itemId, { location, note = "", at }) {
    requireActor(actor, STAFF_ROLES, "登记保管位置");
    const item = this._item(itemId);
    item.storageLocation = { location, note, at: this._at(at), by: actor.id };
    this._log(item, { type: "storage_set", location, by: actor.id, at: item.storageLocation.at });
    return clone(item.storageLocation);
  }

  loanOut(actor, itemId, { toVenue, startAt, endAt, note = "", at }) {
    requireActor(actor, STAFF_ROLES, "办理借展");
    if (!VENUE_TYPES.includes(toVenue)) throw new RightsError(`未知场地类型：${toVenue}`);
    if (endAt <= startAt) throw new RightsError("借展期限不合法");
    const item = this._item(itemId);
    const active = item.loans.find((loan) => !loan.returnedAt);
    if (active) throw new RightsError(`素材仍在借展中：${active.toVenue}`);
    const loan = { id: this._oid("loan"), toVenue, startAt, endAt, by: actor.id, at: this._at(at), note, returnedAt: null };
    item.loans.push(loan);
    this._log(item, { type: "loaned_out", ...loan });
    return clone(loan);
  }

  returnLoan(actor, itemId, { at } = {}) {
    requireActor(actor, STAFF_ROLES, "归还借展");
    const item = this._item(itemId);
    const loan = item.loans.find((candidate) => !candidate.returnedAt);
    if (!loan) throw new RightsError("没有进行中的借展");
    loan.returnedAt = this._at(at);
    this._log(item, { type: "loan_returned", loanId: loan.id, at: loan.returnedAt });
    return clone(loan);
  }

  // ---- 2. 数字来源链 ------------------------------------------------------

  // 数字文件上传：相同指纹归并到同一来源链，而不是产生新素材
  uploadFile(actor, itemId, { fingerprint, uri, at }) {
    const item = this._item(itemId);
    return this._attachFingerprint(item, { fingerprint, uri, uploadedBy: actor?.id, at });
  }

  _attachFingerprint(item, { fingerprint, uri, uploadedBy, at }) {
    if (!fingerprint) throw new RightsError("数字文件必须提供指纹用于归并");
    const sourceId = this._sources.get(fingerprint);
    if (!sourceId) {
      // 首次出现的数字文件：建立来源链
      const newSourceId = this._oid("src");
      this._sources.set(fingerprint, newSourceId);
      item.sourceChain.sourceIds.push(newSourceId);
      item.sourceChain.fingerprints.push(fingerprint);
      this._log(item, { type: "source_registered", sourceId: newSourceId, fingerprint, uri: uri ?? null, uploadedBy: uploadedBy ?? null, at: this._at(at) });
      return clone({ sourceId: newSourceId, fingerprint, merged: false });
    }
    // 相同指纹一律归并：已在本素材链上是重复上传，在别处则挂回同一链
    const alreadyLinked = item.sourceChain.sourceIds.includes(sourceId);
    if (!alreadyLinked) {
      item.sourceChain.sourceIds.push(sourceId);
      item.sourceChain.fingerprints.push(fingerprint);
    }
    this._log(item, {
      type: "source_merged",
      sourceId,
      fingerprint,
      alreadyLinked,
      uri: uri ?? null,
      uploadedBy: uploadedBy ?? null,
      at: this._at(at),
    });
    return clone({ sourceId, fingerprint, merged: true });
  }

  // ---- 3. 作者声明 --------------------------------------------------------

  // role: "author"（图案作者）或 "collector"（寄送人 / 收藏者，不等于作者）
  declareAuthorship(actor, itemId, { claimantId, name, role, evidence = "", at }) {
    if (!["author", "collector"].includes(role)) throw new RightsError("声明角色必须是 author 或 collector");
    const item = this._item(itemId);
    const claim = {
      id: this._oid("claim"),
      claimantId,
      name,
      role,
      evidence,
      at: this._at(at),
      declaredBy: actor?.id ?? claimantId,
    };
    item.authorship.claims.push(claim);
    if (role === "author") {
      const prior = item.authorship.claims.filter((c) => c.role === "author" && c.claimantId !== claimantId);
      const acceptedPrior = prior.filter((c) => item.authorship.acceptedClaimIds.includes(c.id));
      if (acceptedPrior.length > 0) {
        // 与已被接受的作者互斥：认领冲突，立即冻结
        item.authorship.conflict = true;
        this._openDispute(item, {
          reason: "authorship_claim_conflict",
          detail: { claims: [acceptedPrior[0].id, claim.id] },
          raisedBy: actor?.id ?? claimantId,
          at: claim.at,
          freeze: true,
        });
      } else if (!item.authorship.conflict) {
        // 同一认领人重复声明：保留声明记录，但不重复接受
        const alreadyAccepted = item.authorship.claims
          .slice(0, -1)
          .some((c) => c.claimantId === claimantId && item.authorship.acceptedClaimIds.includes(c.id));
        if (!alreadyAccepted) item.authorship.acceptedClaimIds.push(claim.id);
      }
    }
    this._log(item, { type: "authorship_declared", ...claim });
    this._invalidateCascade(item);
    this._refreshInternal(item);
    return clone(claim);
  }

  // ---- 4. 人物同意 --------------------------------------------------------

  // 登记合影中的人物及其同意。未成年人（minor）必须携带监护人同意。
  addPerson(actor, itemId, { personId, name, minor = false, guardian = null, at }) {
    const item = this._item(itemId);
    if (item.persons.some((person) => person.personId === personId)) {
      throw new RightsError(`人物已登记：${personId}`);
    }
    const person = {
      personId,
      name,
      minor,
      guardian: minor ? guardian : null, // { guardianId, name }
      consents: [],
    };
    if (minor && (!guardian || !guardian.guardianId)) {
      throw new RightsError("未成年人必须登记监护人，同意需由监护人作出");
    }
    item.persons.push(person);
    this._log(item, { type: "person_added", personId, minor, at: this._at(at) });
    return clone(person);
  }

  // scope: 允许的用途数组，或 "all"。grantedBy 对未成年人必须是监护人本人。
  grantPersonConsent(actor, itemId, personId, { scope = "all", at, grantedBy } = {}) {
    const item = this._item(itemId);
    const person = item.persons.find((candidate) => candidate.personId === personId);
    if (!person) throw new RightsError(`人物未登记：${personId}`);
    const granter = grantedBy ?? actor?.id;
    if (person.minor && granter !== person.guardian.guardianId) {
      throw new RightsError("未成年人的公开同意只能由监护人作出");
    }
    const consent = { id: this._oid("consent"), scope, grantedBy: granter, at: this._at(at), revokedAt: null };
    person.consents.push(consent);
    this._log(item, { type: "person_consent_granted", personId, ...consent });
    this._invalidateCascade(item);
    this._refreshInternal(item);
    return clone(consent);
  }

  revokePersonConsent(actor, itemId, personId, { at } = {}) {
    const item = this._item(itemId);
    const person = item.persons.find((candidate) => candidate.personId === personId);
    if (!person) throw new RightsError(`人物未登记：${personId}`);
    const active = person.consents.filter((consent) => !consent.revokedAt);
    if (active.length === 0) throw new RightsError("没有生效中的人物同意");
    const revokedAt = this._at(at);
    active.forEach((consent) => {
      consent.revokedAt = revokedAt;
    });
    this._log(item, { type: "person_consent_revoked", personId, by: actor?.id ?? null, at: revokedAt });
    this._haltReferences(item, { at: revokedAt, reason: "人物撤回同意" });
    this._invalidateCascade(item);
    this._refreshInternal(item);
  }

  _consentCovers(person, use, at) {
    return person.consents.some((consent) => {
      if (consent.revokedAt) return false;
      if (consent.at > at) return false;
      return consent.scope === "all" || consent.scope.includes(use);
    });
  }

  // ---- 5. 展示许可与引用 --------------------------------------------------

  grantPermission(actor, itemId, { venueType, use, startAt, endAt, grantee = "", at }) {
    requireActor(actor, DECIDING_ROLES, "授予展示许可");
    if (!VENUE_TYPES.includes(venueType)) throw new RightsError(`未知场地类型：${venueType}`);
    if (endAt <= startAt) throw new RightsError("许可期限不合法");
    const item = this._item(itemId);
    const permission = {
      id: this._oid("perm"),
      venueType,
      use,
      startAt,
      endAt,
      grantee,
      grantedBy: actor.id,
      at: this._at(at),
    };
    item.permissions.push(permission);
    this._log(item, { type: "permission_granted", ...permission });
    this._invalidateCascade(item);
    this._refreshInternal(item);
    return clone(permission);
  }

  // 作者撤回某一种使用：停止该用途的一切新传播；既往引用保留可核查。
  revokeUse(actor, itemId, { use, reason = "", at }) {
    requireActor(actor, DECIDING_ROLES, "撤回使用方式");
    const item = this._item(itemId);
    const revokedAt = this._at(at);
    item.useRevocations.push({ use, revokedAt, revokedBy: actor.id, reason });
    this._log(item, { type: "use_revoked", use, revokedAt, reason, at: revokedAt });
    this._haltReferences(item, { at: revokedAt, reason: `作者撤回用途：${use}` });
    this._invalidateCascade(item);
    this._refreshInternal(item);
  }

  _haltReferences(item, { at, reason }) {
    for (const reference of item.references) {
      if (!reference.haltedAt && reference.endAt > at) {
        reference.haltedAt = at;
        reference.haltReason = reason;
      }
    }
  }

  // 体育场 / 街区 / 临展每次引用都必须绑定用途与期限；权利状态不允许则拒绝。
  createReference(actor, itemId, { venueType, use, startAt, endAt, at }) {
    if (!VENUE_TYPES.includes(venueType)) throw new RightsError(`未知场地类型：${venueType}`);
    if (endAt <= startAt) throw new RightsError("引用期限不合法");
    const item = this._item(itemId);
    const checkAt = startAt ?? this._at(at);
    const decision = this._computeDecision(item, venueType, use, checkAt);
    if (!decision.allowed) {
      throw new RightsError(`引用被权利状态拒绝：${decision.reasons.join("；")}`);
    }
    // 引用期限必须整体落在所依据的许可期限内
    if (!decision.permission || decision.permission.endAt < endAt) {
      throw new RightsError("引用期限超出许可有效期，不能创建");
    }
    const permission = decision.permission;
    const reference = {
      id: this._oid("ref"),
      venueType,
      use,
      startAt,
      endAt,
      permissionId: permission?.id ?? null,
      createdBy: actor?.id ?? null,
      at: this._at(at),
      haltedAt: null,
      haltReason: null,
    };
    item.references.push(reference);
    this._log(item, { type: "reference_created", ...reference });
    return clone(reference);
  }

  // ---- 衍生版本：裁切 / 配音 / 翻译 / 主题故事 ----------------------------

  createDerivative(actor, sourceItemId, { id, transform, title = "", use, venueType, endAt, startAt, at }) {
    if (!TRANSFORMS.includes(transform)) throw new RightsError(`未知衍生方式：${transform}`);
    const source = this._item(sourceItemId);
    if (source.frozen) throw new RightsError("源素材处于争议冻结，不能制作衍生版本");
    const now = this._at(at);
    this.registerItem({
      id,
      kind: "derivative",
      title,
      uploadedBy: actor?.id,
      fingerprint: `derived:${sourceItemId}:${transform}:${source.sourceChain.fingerprints[0] ?? "nofp"}`,
      at: now,
    });
    const derivative = this._item(id);
    derivative.derivedFrom = { itemId: sourceItemId, transform, editor: actor?.id ?? null, at: now };
    // 衍生版本的作者为编辑者，但展示时仍受原作品许可约束
    derivative.authorship.claims.push({
      id: this._oid("claim"),
      claimantId: actor?.id ?? "unknown-editor",
      name: actor?.name ?? "社区编辑",
      role: "author",
      evidence: `衍生方式：${transform}`,
      at: now,
      declaredBy: actor?.id ?? null,
    });
    derivative.authorship.acceptedClaimIds.push(derivative.authorship.claims[0].id);
    source.derivativeIds.push(id);
    this._log(derivative, { type: "derived_from", sourceItemId, transform, use, venueType });
    this._log(source, { type: "derivative_created", derivativeId: id, transform, by: actor?.id ?? null, at: now });
    this._refreshInternal(derivative);
    return clone(derivative);
  }

  // ---- 争议：冻结、快照保全、授权裁决 ------------------------------------

  raiseDispute(actor, itemId, { reason, detail = {}, at } = {}) {
    const item = this._item(itemId);
    return this._openDispute(item, { reason, detail, raisedBy: actor?.id ?? null, at, freeze: true });
  }

  _openDispute(item, { reason, detail, raisedBy, at, freeze }) {
    const dispute = {
      id: this._oid("disp"),
      reason,
      detail,
      raisedBy: raisedBy ?? null,
      at: this._at(at),
      resolved: null,
    };
    item.disputes.push(dispute);
    if (freeze && !item.frozen) {
      item.frozen = {
        disputeId: dispute.id,
        reason,
        raisedBy: raisedBy ?? null,
        at: dispute.at,
        // 保全冻结时点的完整状态，供事后核查
        snapshot: clone(item),
      };
    }
    if (freeze) {
      this._haltReferences(item, { at: dispute.at, reason: `争议冻结：${reason}` });
    }
    this._log(item, { type: "dispute_opened", ...dispute, frozen: freeze });
    this._invalidateCascade(item);
    this._refreshInternal(item);
    return clone(dispute);
  }

  // 只有获授权人员（权利专员）能作处理决定
  resolveDispute(actor, itemId, { decision, note = "", at } = {}) {
    requireActor(actor, DECIDING_ROLES, "争议裁决");
    const item = this._item(itemId);
    const dispute = item.disputes.find((candidate) => !candidate.resolved);
    if (!dispute) throw new RightsError("没有待裁决的争议");

    let nextAccepted = null;
    if (dispute.reason === "authorship_claim_conflict") {
      const claimExists = (claimId) => item.authorship.claims.some((claim) => claim.id === claimId);
      if (decision.type === "accept") {
        if (!claimExists(decision.claimId)) throw new RightsError("裁决指向的作者声明不存在");
        nextAccepted = [decision.claimId];
      } else if (decision.type === "co_authors") {
        if (!Array.isArray(decision.claimIds) || decision.claimIds.length === 0) {
          throw new RightsError("共同作者裁决必须提供声明列表");
        }
        if (decision.claimIds.some((claimId) => !claimExists(claimId))) {
          throw new RightsError("裁决指向的作者声明不存在");
        }
        nextAccepted = [...decision.claimIds];
      } else if (decision.type === "reject") {
        nextAccepted = [];
      } else {
        throw new RightsError("未知裁决类型");
      }
    }

    dispute.resolved = { decision, note, by: actor.id, at: this._at(at) };
    if (nextAccepted !== null) {
      item.authorship.acceptedClaimIds = nextAccepted;
      item.authorship.conflict = false;
    }
    // 没有其他未决争议时解除冻结
    if (!item.disputes.some((candidate) => !candidate.resolved)) {
      item.frozen = null;
    }
    this._log(item, { type: "dispute_resolved", disputeId: dispute.id, ...dispute.resolved });
    this._invalidateCascade(item);
    this._refreshInternal(item);
    return clone(dispute);
  }

  getSnapshot(itemId) {
    const item = this._item(itemId);
    if (!item.frozen) throw new RightsError("素材当前不在冻结状态");
    return clone(item.frozen.snapshot);
  }

  // ---- 统一权利状态收敛 ---------------------------------------------------

  _invalidateCascade(item) {
    this._cache.invalidateItem(item.id);
    for (const derivativeId of item.derivativeIds) {
      const derivative = this._items.get(derivativeId);
      if (derivative) this._invalidateCascade(derivative);
    }
  }

  _refreshInternal(item) {
    item.internal = !this._chainReady(item);
  }

  // 核心收敛：所有入口共用这一份判定
  _computeDecision(item, venueType, use, at) {
    const reasons = [];

    if (item.frozen) reasons.push(`争议冻结中：${item.frozen.reason}`);
    if (item.authorship.conflict) reasons.push("作者认领冲突待裁决");

    const authors = item.authorship.claims.filter(
      (claim) => claim.role === "author" && item.authorship.acceptedClaimIds.includes(claim.id),
    );
    if (authors.length === 0) reasons.push("作者尚未确认（寄送人不等于作者）");

    for (const person of item.persons) {
      if (person.minor && !person.guardian) {
        reasons.push(`未成年人 ${person.name} 缺少监护人`);
      } else if (person.consents.every((consent) => consent.revokedAt)) {
        reasons.push(`缺少${person.minor ? "监护人" : "人物"}同意：${person.name}`);
      } else if (use && !this._consentCovers(person, use, at)) {
        reasons.push(`${person.minor ? "监护人" : "人物"}同意不覆盖该用途/时点：${person.name}`);
      }
    }

    // 衍生版本还受原作品权利状态约束；同场地同用途的许可可沿来源链继承
    let parentBlocked = false;
    let inheritedPermission = null;
    if (item.derivedFrom) {
      const parent = this._items.get(item.derivedFrom.itemId);
      if (!parent) {
        reasons.push("源素材缺失");
        parentBlocked = true;
      } else if (venueType && use) {
        const parentDecision = this._computeDecision(parent, venueType, use, at);
        if (!parentDecision.allowed) {
          reasons.push(`源素材不允许该用途（${parentDecision.reasons[0] ?? "未授权"}）`);
          parentBlocked = true;
        }
        inheritedPermission = parentDecision.permission;
      } else if (!this._chainReady(parent)) {
        reasons.push("源素材权利未确认");
        parentBlocked = true;
      }
    }

    let permission = null;
    if (venueType && use) {
      const revoked = item.useRevocations.find((revocation) => revocation.use === use && revocation.revokedAt <= at);
      if (revoked) reasons.push(`用途「${use}」已被作者撤回（${revoked.revokedAt}）`);
      permission =
        item.permissions.find(
          (candidate) =>
            candidate.venueType === venueType &&
            candidate.use === use &&
            candidate.startAt <= at &&
            candidate.endAt >= at,
        ) ??
        inheritedPermission ??
        null;
      if (!permission) reasons.push(`缺少覆盖 ${venueType}/${use} 的有效许可（含期限）`);
    }

    const ready = this._chainReady(item) && !parentBlocked;
    const useRevoked =
      venueType && use
        ? item.useRevocations.some((r) => r.use === use && r.revokedAt <= at)
        : item.useRevocations.length > 0;
    const allowed = ready && !!permission && !useRevoked;

    return { allowed, ready, reasons, permission };
  }

  // 权威权利状态
  getRightsState(itemId, { at } = {}) {
    const item = this._item(itemId);
    const moment = this._at(at);
    const decision = this._computeDecision(item, null, null, moment);
    let status;
    if (item.frozen) status = "frozen";
    else if (item.useRevocations.length > 0) status = "restricted";
    else if (!decision.ready) status = "unverified";
    else status = "cleared";
    return {
      itemId,
      status,
      rightsReady: decision.ready,
      internalOnly: !decision.ready,
      at: moment,
      activeUseRevocations: item.useRevocations.map((r) => r.use),
    };
  }

  // 带缓存的统一入口判定；任何场地都必须走这里
  canDisplay(itemId, { venueType, use, at } = {}) {
    const moment = this._at(at);
    const key = `${itemId}|${venueType}|${use}|${moment}`;
    const nowMs = this._ms(this._now().toISOString());
    const cached = this._cache.get(key, nowMs);
    if (cached) return cached;

    const item = this._item(itemId);
    const decision = this._computeDecision(item, venueType, use, moment);
    const result = {
      itemId,
      venueType,
      use,
      at: moment,
      allowed: decision.allowed,
      reasons: decision.reasons,
      permissionId: decision.permission?.id ?? null,
    };
    // 缓存上限不得晚于所依据许可的到期时间
    this._cache.set(key, result, nowMs, decision.permission ? this._ms(decision.permission.endAt) : null);
    return result;
  }

  // ---- 员工视图与公众视图 -------------------------------------------------

  // 馆藏人员：完整来历、保管位置、借展与全部权利记录（含内部保存内容）
  staffView(itemId) {
    const item = this._item(itemId);
    const state = this.getRightsState(itemId);
    return {
      ...clone(item),
      rightsState: state,
    };
  }

  // 公众：只能看到获准公开的来历；未授权 / 冻结 / 内部素材一律不可见
  publicView(itemId, { venueType, use, at } = {}) {
    let item;
    try {
      item = this._item(itemId);
    } catch {
      return null; // 不向公众暴露素材是否存在
    }
    if (venueType && use) {
      if (!this.canDisplay(itemId, { venueType, use, at }).allowed) return null;
    } else {
      // 无具体场地上下文时，只有完全 cleared 的来历可公开；restricted 必须逐用途判定
      const state = this.getRightsState(itemId, { at });
      if (state.status !== "cleared") return null;
    }
    const authors = item.authorship.claims
      .filter((claim) => claim.role === "author" && item.authorship.acceptedClaimIds.includes(claim.id))
      .map((claim) => claim.name);
    const view = {
      id: item.id,
      kind: item.kind,
      title: item.title,
      creditedAuthors: authors,
    };
    if (item.derivedFrom) {
      view.derivedFrom = { itemId: item.derivedFrom.itemId, transform: item.derivedFrom.transform };
    }
    if (venueType && use) {
      const decision = this.canDisplay(itemId, { venueType, use, at });
      const permission = item.permissions.find((candidate) => candidate.id === decision.permissionId);
      if (permission) {
        view.display = { venueType, use, startAt: permission.startAt, endAt: permission.endAt };
      }
    }
    // 保管位置、借展安排、收藏者信息、人物身份、争议记录均不进入公众视图
    return view;
  }

  listPublic({ venueType, use, at } = {}) {
    return [...this._items.keys()]
      .map((id) => this.publicView(id, { venueType, use, at }))
      .filter(Boolean);
  }
}
