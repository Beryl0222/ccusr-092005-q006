// 场景样例：一面球迷旗帜与一张含未成年人的合影
// 串起题目中的全部环节：寄送人（收藏者）≠ 图案作者、家长未同意时仅内部保存、
// 重复上传归并、三场地引用、撤回停新传播、衍生版本、认领冲突、争议冻结、跨场地借展。

import { fingerprintOf, LicenseCache, Registry, publicView, staffView } from "./domain.js";

export const VENUES = {
  STADIUM: "永州体育场",
  STREET: "球迷主题街区",
  POPUP: "城市临展",
};

export const OFFICER = { id: "officer-li", role: "rights_officer", name: "李权管" };

export function buildScenario({ now = () => new Date("2026-09-01T09:00:00Z") } = {}) {
  const registry = new Registry({ now });
  const t = (days, hour = 9) => new Date(2026, 8, days, hour).toISOString(); // 本地时间 2026-09-xx

  // 1) 登记旗帜素材与数字文件来源（寄送人自称收藏者，不等于作者）
  const flagFp = fingerprintOf({ design: "湘超冠军旗", colors: ["红", "金"] });
  registry.registerItem({
    id: "flag-001",
    kind: "fan_artifact",
    title: "湘超冠军球迷旗",
    fingerprint: flagFp,
    uploadedBy: { name: "周收藏", contact: "collector@example" },
    provenance: "城市展览寄送征集",
  });

  // 实物保管位置
  registry.recordCustody("flag-001", { location: VENUES.STADIUM, custodian: "体育场库房 王保管" });

  // 作者声明：收藏者先声称“图是我找别人画的”，真正作者随后认领
  registry.addClaim("flag-001", {
    claimId: "claim-collector-1",
    party: { name: "周收藏", role: "collector" },
    role: "collector",
    evidence: "寄送单",
  });
  registry.addClaim("flag-001", {
    claimId: "claim-author-1",
    party: { name: "陈画笔", contact: "artist@example" },
    role: "author",
    evidence: "设计源文件",
  });

  // 2) 合影：含一名未成年人，家长尚未同意公开
  const photoFp = fingerprintOf({ shot: "看台合影", match: "湘超决赛" });
  registry.registerItem({
    id: "photo-002",
    kind: "photograph",
    title: "决赛看台合影",
    fingerprint: photoFp,
    uploadedBy: { name: "周收藏" },
    provenance: "征集材料包",
  });
  registry.recordCustody("photo-002", { location: "市文化馆库房", custodian: "馆藏组" });
  registry.addClaim("photo-002", {
    claimId: "claim-photo-author",
    party: { name: "陈画笔" },
    role: "author",
    evidence: "RAW 原片",
  });
  registry.recordConsent("photo-002", {
    consentId: "consent-kid",
    person: { name: "小球迷", minor: true },
    guardian: null, // 家长没有同意公开
    granted: false,
  });

  return { registry, t };
}

// 在已构建的样例上推进：确认权属、发放许可、三场地引用、衍生与撤回
export function advanceScenario({ registry, t }) {
  // 收藏者声明被授权人员核实为“寄送/收藏关系”，作者认领成立
  registry.resolveClaim("claim-collector-1", { accept: false }, OFFICER);
  registry.resolveClaim("claim-author-1", { accept: true }, OFFICER);
  registry.resolveClaim("claim-photo-author", { accept: true }, OFFICER);

  // 旗帜获两项用途许可：现场大屏与临展印制；合影仍因家长未同意不能公开
  registry.grantLicense("flag-001", {
    licenseId: "lic-screen",
    purpose: "现场大屏展示",
    venues: [VENUES.STADIUM, VENUES.STREET],
    start: t(1),
    end: t(30),
  });
  registry.grantLicense("flag-001", {
    licenseId: "lic-print",
    purpose: "临展印制",
    venues: [VENUES.POPUP],
    start: t(1),
    end: t(20),
  });

  // 体育场、街区引用旗帜（每次引用绑定用途与期限）
  registry.createReference(
    "flag-001",
    { venue: VENUES.STADIUM, purpose: "现场大屏展示", start: t(2), end: t(29) },
    t(2),
  );
  registry.createReference(
    "flag-001",
    { venue: VENUES.STREET, purpose: "现场大屏展示", start: t(3), end: t(28) },
    t(3),
  );

  // 社区编辑：裁切配图、配音短片、翻译图说，均为独立衍生版本
  registry.createDerivative("flag-001", {
    id: "flag-001-crop",
    kind: "image_edit",
    title: "旗帜裁切配图",
    transform: "裁切",
    editor: "社区编辑 小林",
  });
  registry.createDerivative("flag-001", {
    id: "flag-001-voice",
    kind: "audio_video",
    title: "旗帜配音短片",
    transform: "配音",
    editor: "社区编辑 小林",
  });
  registry.createDerivative("flag-001", {
    id: "flag-001-en",
    kind: "text_translation",
    title: "旗帜图说英译",
    transform: "翻译",
    editor: "社区编辑 阿May",
  });

  return { registry, t };
}

export { fingerprintOf, LicenseCache, publicView, staffView };
