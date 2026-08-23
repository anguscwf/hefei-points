const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

function enabled(name) {
  return TRUE_VALUES.has(String(process.env[name] || '').trim().toLowerCase());
}

module.exports = Object.freeze({
  isLegacyChildLoginEnabled: () => enabled('LEGACY_CHILD_LOGIN_ENABLED'),
  isLegacyChildManagementEnabled: () => enabled('LEGACY_CHILD_MANAGEMENT_ENABLED'),
  isChildEnrollmentEnabled: () => enabled('CHILD_ENROLLMENT_ENABLED'),
  isHarmonyChildEnabled: () => enabled('HARMONY_CHILD_ENABLED'),
  isDevicePairingEnabled: () => enabled('DEVICE_PAIRING_ENABLED'),
  isPointRequestsEnabled: () => enabled('POINT_REQUESTS_ENABLED'),
  isChildDataRightsEnabled: () => enabled('CHILD_DATA_RIGHTS_ENABLED')
});
