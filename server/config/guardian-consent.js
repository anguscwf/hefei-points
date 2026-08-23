const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const LEGAL_TEXT_TYPES = Object.freeze([
  'privacy_policy',
  'child_personal_information_rules',
  'child_user_agreement',
  'sensitive_information_notice'
]);

const LEGAL_TEXT_FIELDS = Object.freeze({
  privacy_policy: 'privacyPolicy',
  child_personal_information_rules: 'childPersonalInformationRules',
  child_user_agreement: 'childUserAgreement',
  sensitive_information_notice: 'sensitiveInformationNotice'
});

const LEGAL_TEXT_PATH_SLUGS = Object.freeze({
  privacy_policy: 'privacy-policy',
  child_personal_information_rules: 'child-personal-information-rules',
  child_user_agreement: 'child-user-agreement',
  sensitive_information_notice: 'sensitive-information-notice',
  guardian_relation_declaration: 'guardian-relation-declaration'
});

const REAUTH_PURPOSES = Object.freeze(new Set([
  'child_enrollment',
  'child_consent',
  'child_consent_withdraw',
  'child_data_access',
  'child_data_export',
  'child_data_correct',
  'child_data_delete',
  'child_service_terminate'
]));

const GUARDIAN_RELATIONS = Object.freeze(new Set([
  'father',
  'mother',
  'legal_guardian',
  'other_guardian'
]));

function legalPublicOrigin() {
  const raw = String(process.env.LEGAL_PUBLIC_ORIGIN || '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:'
        || parsed.username
        || parsed.password
        || parsed.port
        || parsed.pathname !== '/'
        || parsed.search
        || parsed.hash
        || parsed.origin !== raw) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function expectedLegalPublicUrl({ type, version, sha256 }) {
  const origin = legalPublicOrigin();
  const slug = LEGAL_TEXT_PATH_SLUGS[type];
  if (!origin || !slug || !VERSION.test(version) || !SHA256.test(sha256)) return null;
  return `${origin}/legal/${slug}/${version}/${sha256}.html`;
}

function isExpectedLegalPublicUrl(evidence) {
  const expected = expectedLegalPublicUrl(evidence);
  return expected !== null && evidence.publicUrl === expected;
}

function guardianRelationDeclaration() {
  const version = String(process.env.GUARDIAN_RELATION_DECLARATION_VERSION || '').trim();
  const sha256 = String(process.env.GUARDIAN_RELATION_DECLARATION_SHA256 || '').trim();
  const publicUrl = String(process.env.GUARDIAN_RELATION_DECLARATION_PUBLIC_URL || '').trim();
  const declaration = {
    type: 'guardian_relation_declaration', version, sha256, publicUrl
  };
  if (!isExpectedLegalPublicUrl(declaration)) return null;
  return { version, sha256, publicUrl };
}

module.exports = {
  SHA256,
  VERSION,
  LEGAL_TEXT_TYPES,
  LEGAL_TEXT_FIELDS,
  LEGAL_TEXT_PATH_SLUGS,
  REAUTH_PURPOSES,
  GUARDIAN_RELATIONS,
  legalPublicOrigin,
  expectedLegalPublicUrl,
  isExpectedLegalPublicUrl,
  guardianRelationDeclaration
};
