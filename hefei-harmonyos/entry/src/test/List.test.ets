import clientTests from './Client.test';
import protocolTests from './Protocol.test';
import recoveryTests from './Recovery.test';

export default function testsuite(): void {
  clientTests();
  protocolTests();
  recoveryTests();
}
