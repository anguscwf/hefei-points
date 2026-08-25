import clientTests from './Client.test';
import privacySafetyShellTests from './PrivacySafetyShell.test';
import protocolTests from './Protocol.test';
import recoveryTests from './Recovery.test';

export default function testsuite(): void {
  clientTests();
  privacySafetyShellTests();
  protocolTests();
  recoveryTests();
}
