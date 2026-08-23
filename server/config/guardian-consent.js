const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HTTPS_URL = /^https:\/\/[^\s]+$/;

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

function guardianRelationDeclaration() {
  const version = String(process.env.GUARDIAN_RELATION_DECLARATION_VERSION || '').trim();
  const sha256 = String(process.env.GUARDIAN_RELATION_DECLARATION_SHA256 || '').trim();
  const publicUrl = String(process.env.GUARDIAN_RELATION_DECLARATION_PUBLIC_URL || '').trim();
  if (!VERSION.test(version) || !SHA256.test(sha256) || !HTTPS_URL.test(publicUrl)) return null;
  return { version, sha256, publicUrl };
}

module.exports = {
  SHA256,
  VERSION,
  HTTPS_URL,
  LEGAL_TEXT_TYPES,
  LEGAL_TEXT_FIELDS,
  REAUTH_PURPOSES,
  GUARDIAN_RELATIONS,
  guardianRelationDeclaration
};
