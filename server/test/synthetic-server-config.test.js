const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..', '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tangguan-synthetic-config-'));
const profile = require('../config/deployment-profile');
const runtimeFilesystem = require('../config/synthetic-runtime-filesystem');
const preflight = require('../../scripts/preflight-synthetic-api');
const committedPreflightVerifier = require('../../scripts/verify-synthetic-api-preflight');
const committedPreflightImplementationFiles = Object.freeze([
  'package.json',
  'scripts/preflight-synthetic-api.js',
  'scripts/support/synthetic-preflight-offline-guard.js',
  'scripts/verify-synthetic-api-preflight.js',
  'server/config/defaults.js',
  'server/config/deployment-profile.js',
  'server/config/env.js',
  'server/config/synthetic-runtime-filesystem.js',
  'server/db/connection.js',
  'server/lib/backup.js',
  'server/lib/token.js',
  'server/lib/wx-auth.js',
  'server/routes/backup.js'
]);

function syntheticEnvironment(overrides = {}) {
  const root = path.join(tempRoot, 'tangguan-synthetic-stage1');
  const origin = 'https://synthetic-api.example.com';
  return {
    NODE_ENV: 'production',
    DEPLOYMENT_TIER: 'synthetic',
    SYNTHETIC_RUNTIME_ACK: profile.SYNTHETIC_RUNTIME_ACK,
    SYNTHETIC_APP_CREDENTIALS_ACK: profile.SYNTHETIC_APP_CREDENTIALS_ACK,
    SYNTHETIC_DATA_ACK: profile.SYNTHETIC_DATA_ACK,
    SYNTHETIC_DATASET_ID: 'synthetic-stage1-family',
    SYNTHETIC_DATA_ROOT: root,
    DATA_DIR: path.join(root, 'data'),
    SQLITE_FILE: path.join(root, 'data', 'hefei-points-synthetic.sqlite'),
    API_PUBLIC_ORIGIN: origin,
    LEGAL_PUBLIC_ORIGIN: origin,
    GUARDIAN_RELATION_DECLARATION_VERSION: 'synthetic-relation-v1',
    GUARDIAN_RELATION_DECLARATION_SHA256: 'e'.repeat(64),
    GUARDIAN_RELATION_DECLARATION_PUBLIC_URL:
      `${origin}/legal/guardian-relation-declaration/synthetic-relation-v1/${'e'.repeat(64)}.html`,
    WX_APPID: 'wx0123456789abcdef',
    WX_APPSECRET: 'synthetic-secret-material-only',
    HARMONY_CHILD_ENABLED: 'true',
    CHILD_ENROLLMENT_ENABLED: 'true',
    DEVICE_PAIRING_ENABLED: 'true',
    POINT_REQUESTS_ENABLED: 'true',
    CHILD_DATA_RIGHTS_ENABLED: 'false',
    LEGACY_CHILD_LOGIN_ENABLED: 'false',
    LEGACY_CHILD_MANAGEMENT_ENABLED: 'false',
    PAIRING_CLIENT_IP_MODE: 'direct',
    TRUSTED_PROXIES: '',
    LOG_LEVEL: 'info',
    ...overrides
  };
}

function assertCode(work, code) {
  assert.throws(work, error => error instanceof profile.DeploymentConfigError
    && error.code === code);
}

function assertRuntimeCode(work, code = 'SYNTHETIC_DATA_ROOT_UNSAFE') {
  assert.throws(work, error => error && error.code === code);
}

function createPhysicalSyntheticRoot(environment) {
  const deployment = profile.validateSyntheticDeployment(environment, { projectRoot });
  fs.mkdirSync(deployment.dataPaths.dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(deployment.dataPaths.root, runtimeFilesystem.SYNTHETIC_DATA_MARKER_FILENAME),
    runtimeFilesystem.markerBufferFor(deployment),
    { flag: 'wx' }
  );
  return deployment;
}

function fakeProvenance() {
  return Object.freeze({
    sourceCommit: 'a'.repeat(40),
    implementationIndexMatchesHead: true,
    implementationWorktreeMatchesHeadAfterEolNormalization: true,
    implementationTreeSha256: 'b'.repeat(64),
    implementationFiles: Object.freeze([
      Object.freeze({ path: 'synthetic-fixture.js', sha256: 'c'.repeat(64) })
    ])
  });
}

test('preflight 只把 CRLF/LF 规范化视为相同实现内容', () => {
  assert.equal(
    preflight.runningContentMatchesCommitted(
      Buffer.from('const value = 1;\r\nmodule.exports = value;\r\n'),
      Buffer.from('const value = 1;\nmodule.exports = value;\n')
    ),
    true
  );
  assert.equal(
    preflight.runningContentMatchesCommitted(
      Buffer.from('const value = 2;\r\nmodule.exports = value;\r\n'),
      Buffer.from('const value = 1;\nmodule.exports = value;\n')
    ),
    false
  );
  assert.equal(
    preflight.runningContentMatchesCommitted(
      Buffer.from('const value = 1;\rmodule.exports = value;\n'),
      Buffer.from('const value = 1;\nmodule.exports = value;\n')
    ),
    false
  );
});

test('committed preflight guard 阻断网络、非 Git 子进程和边界外写入', () => {
  const verificationRoot = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'tangguan-synthetic-api-preflight-verification-'
  ));
  const output = path.join(verificationRoot, 'evidence');
  const outside = path.join(tempRoot, 'preflight-guard-outside-write');
  const readableSentinel = path.join(tempRoot, 'preflight-guard-readable-sentinel');
  const dotenvSentinel = path.join(tempRoot, 'preflight-guard-readable.env');
  fs.writeFileSync(readableSentinel, 'synthetic sentinel', { flag: 'wx' });
  fs.writeFileSync(dotenvSentinel, 'TANGGUAN_GUARD_CANARY=must-not-load\n', { flag: 'wx' });
  const guard = path.join(
    projectRoot,
    'scripts',
    'support',
    'synthetic-preflight-offline-guard.js'
  );
  const program = [
    "const fs=require('node:fs');",
    "const childProcess=require('node:child_process');",
    "const net=require('node:net');",
    "const os=require('node:os');",
    "const path=require('node:path');",
    `const implementationFiles=${JSON.stringify(committedPreflightImplementationFiles)};`,
    "const realpathSync=fs.realpathSync.native||fs.realpathSync;",
    "const gitEnvironment={};",
    "const inherited=new Set(['COMSPEC','LANG','LC_ALL','LC_CTYPE','PATH','PATHEXT','SYSTEMROOT','TEMP','TMP','TMPDIR','WINDIR']);",
    "for(const [key,value] of Object.entries(process.env)){if(inherited.has(key.toUpperCase())&&typeof value==='string')gitEnvironment[key]=value;}",
    "Object.assign(gitEnvironment,{GIT_ATTR_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':os.devNull,GIT_CONFIG_NOSYSTEM:'1',GIT_OPTIONAL_LOCKS:'0',GIT_NO_LAZY_FETCH:'1',GIT_NO_REPLACE_OBJECTS:'1',GIT_PROTOCOL_FROM_USER:'0',GIT_TERMINAL_PROMPT:'0'});",
    "const prefix=['--no-pager','--no-optional-locks','--no-replace-objects','-c','core.fsmonitor=false','-c','safe.directory='+realpathSync(process.cwd())];",
    "const runGit=(command,extra={encoding:'utf8'})=>childProcess.execFileSync('git',[...prefix,...command],{cwd:process.cwd(),windowsHide:true,env:gitEnvironment,maxBuffer:16*1024*1024,...extra});",
    '(async()=>{',
    'let completedGitStep=0;',
    'let commit;',
    'let oids;',
    'try{',
    "  const root=runGit(['rev-parse','--show-toplevel']).slice(0,-1);completedGitStep=1;",
    "  if(path.relative(realpathSync(process.cwd()),realpathSync(root))!=='')throw new Error('ROOT');",
    "  commit=runGit(['rev-parse','--verify','HEAD^{commit}']).slice(0,-1);completedGitStep=2;",
    "  const index=runGit(['ls-files','--stage','-z','--',...implementationFiles]);completedGitStep=3;",
    "  const tree=runGit(['ls-tree','-r','-z','--full-tree',commit,'--',...implementationFiles]);completedGitStep=4;",
    "  if(index.replaceAll(' 0\\t','\\t')!==tree.replaceAll(' blob ',' '))throw new Error('TREE');",
    "  oids=tree.split('\\0').filter(Boolean).map(record=>record.split(/[ \\t]/)[2]);",
    "  runGit(['cat-file','--batch'],{encoding:null,input:oids.join('\\n')+'\\n'});completedGitStep=5;",
    "  runGit(['rev-parse','--verify','HEAD^{commit}']);completedGitStep=6;",
    "  runGit(['ls-files','--stage','-z','--',...implementationFiles]);completedGitStep=7;",
    "  runGit(['ls-tree','-r','-z','--full-tree',commit,'--',...implementationFiles]);completedGitStep=8;",
    "  completedGitStep='8-mkdtemp';const staging=fs.mkdtempSync(path.join(process.env.GUARD_TEST_ROOT,'.tangguan-api-preflight-stage-'));",
    "  const evidenceFile=path.join(staging,'.synthetic-api-preflight.json');",
    "  completedGitStep='8-write';fs.writeFileSync(evidenceFile,Buffer.from('{}\\n'),{flag:'wx'});",
    "  completedGitStep='8-read';if(!fs.readFileSync(evidenceFile).equals(Buffer.from('{}\\n')))throw new Error('EVIDENCE');",
    "  runGit(['rev-parse','--show-toplevel']);completedGitStep=9;",
    "  runGit(['rev-parse','--verify','HEAD^{commit}']);completedGitStep=10;",
    "  runGit(['ls-files','--stage','-z','--',...implementationFiles]);completedGitStep=11;",
    "  runGit(['ls-tree','-r','-z','--full-tree',commit,'--',...implementationFiles]);completedGitStep=12;",
    "  runGit(['cat-file','--batch'],{encoding:null,input:oids.join('\\n')+'\\n'});completedGitStep=13;",
    "  runGit(['rev-parse','--verify','HEAD^{commit}']);completedGitStep=14;",
    "  runGit(['ls-files','--stage','-z','--',...implementationFiles]);completedGitStep=15;",
    "  runGit(['ls-tree','-r','-z','--full-tree',commit,'--',...implementationFiles]);completedGitStep=16;",
    "  fs.renameSync(staging,process.env.GUARD_TEST_OUTPUT);",
    '}catch(error){',
    "  process.stderr.write('guard git step '+completedGitStep+' failed ('+(error.guardReason||error.code||'INVALID')+')\\n');",
    '  process.exitCode=20;return;',
    '}',
    "if(!Object.isFrozen(JSON)||!Object.isFrozen(path)||!Object.isFrozen(Function.prototype)){process.exitCode=21;return;}",
    'const attempts=[',
    "  ()=>fs.writeFileSync(process.env.GUARD_TEST_OUTSIDE,'blocked'),",
    "  ()=>fs.readFileSync(process.env.GUARD_TEST_OUTSIDE,{flag:'w+'}),",
    "  ()=>fs.readFileSync(process.env.GUARD_TEST_READABLE),",
    "  ()=>fs.openAsBlob(process.env.GUARD_TEST_READABLE).then(blob=>blob.text()),",
    "  ()=>fs.closeSync(2),",
    "  ()=>childProcess.execFileSync(process.execPath,['-e','process.exit(0)']),",
    "  ()=>net.connect({host:'127.0.0.1',port:9}),",
    "  ()=>new net['Ser'+'ver'](),",
    "  ()=>fetch('https://synthetic-api.example.com'),",
    "  ()=>require('node:sqlite'),",
    "  ()=>process['getBuiltin'+'Module']('node:sqlite'),",
    "  ()=>process['bind'+'ing']('fs'),",
    "  ()=>process['_linked'+'Binding']('fs'),",
    "  ()=>process['dl'+'open'](),",
    "  ()=>process['exec'+'ve']('\\0',[],{}),",
    "  ()=>process['loadEnv'+'File'](process.env.GUARD_TEST_DOTENV),",
    "  ()=>process.report.writeReport(process.env.GUARD_TEST_OUTSIDE),",
    "  ()=>module['constr'+'uctor']['register'+'Hooks']({resolve(){return {url:'node:sqlite',shortCircuit:true};}}),",
    "  ()=>((()=>{})['constr'+'uctor']('return im'+'port(\\\"node:sqlite\\\")'))(),",
    "  ()=>runGit(['status','--porcelain=v1'])",
    '];',
    'for(const attempt of attempts){if(process.exitCode)break;',
    '  try{await attempt();process.exitCode=11;break;}',
    "  catch(error){if(error.code!=='SYNTHETIC_PREFLIGHT_OFFLINE_FORBIDDEN'){process.exitCode=12;break;}}",
    '}',
    "if(process.env.TANGGUAN_GUARD_CANARY!==undefined)process.exitCode=13;",
    "if(!process.exitCode)process.stdout.write('offline guard blocked unsafe operations\\n');",
    "})().catch(()=>{process.exitCode=22;});"
  ].join('\n');
  const guardEnvironment = {
    ...process.env,
    TANGGUAN_PREFLIGHT_GUARD_ROOT: verificationRoot,
    TANGGUAN_PREFLIGHT_GUARD_OUTPUT: output,
    GUARD_TEST_OUTSIDE: outside,
    GUARD_TEST_READABLE: readableSentinel,
    GUARD_TEST_DOTENV: dotenvSentinel,
    GUARD_TEST_ROOT: verificationRoot,
    GUARD_TEST_OUTPUT: output
  };
  delete guardEnvironment.TANGGUAN_GUARD_CANARY;
  try {
    const result = spawnSync(process.execPath, ['--require', guard, '-e', program], {
      cwd: projectRoot,
      env: guardEnvironment,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'offline guard blocked unsafe operations\n');
    assert.equal(result.stderr, '');
    assert.equal(fs.existsSync(outside), false);
    assert.equal(fs.readFileSync(readableSentinel, 'utf8'), 'synthetic sentinel');
    const probeEvidence = path.join(output, '.synthetic-api-preflight.json');
    assert.equal(fs.readFileSync(probeEvidence, 'utf8'), '{}\n');
    fs.unlinkSync(probeEvidence);
    fs.rmdirSync(output);
    const help = spawnSync(process.execPath, [
      '--require',
      guard,
      path.join(projectRoot, 'scripts', 'preflight-synthetic-api.js'),
      '--help'
    ], {
      cwd: projectRoot,
      env: {
        ...process.env,
        TANGGUAN_PREFLIGHT_GUARD_ROOT: verificationRoot,
        TANGGUAN_PREFLIGHT_GUARD_OUTPUT: output
      },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000
    });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /^Usage:\n/);
    assert.equal(help.stderr, '');
    assert.deepEqual(fs.readdirSync(verificationRoot), []);
  } finally {
    if (fs.existsSync(readableSentinel)
        && fs.lstatSync(readableSentinel).isFile()
        && !fs.lstatSync(readableSentinel).isSymbolicLink()
        && fs.lstatSync(readableSentinel).nlink === 1) {
      fs.unlinkSync(readableSentinel);
    }
    if (fs.existsSync(dotenvSentinel)
        && fs.lstatSync(dotenvSentinel).isFile()
        && !fs.lstatSync(dotenvSentinel).isSymbolicLink()
        && fs.lstatSync(dotenvSentinel).nlink === 1) {
      fs.unlinkSync(dotenvSentinel);
    }
    if (fs.existsSync(verificationRoot)
        && fs.lstatSync(verificationRoot).isDirectory()
        && !fs.lstatSync(verificationRoot).isSymbolicLink()
        && fs.readdirSync(verificationRoot).length === 0) {
      fs.rmdirSync(verificationRoot);
    }
  }
});

test('committed preflight guard 锁死 Git 乱序、错 OID、重复 batch 与动态 import', () => {
  const guard = path.join(
    projectRoot,
    'scripts',
    'support',
    'synthetic-preflight-offline-guard.js'
  );
  const program = [
    "const childProcess=require('node:child_process');",
    "const fs=require('node:fs');",
    "const os=require('node:os');",
    `const implementationFiles=${JSON.stringify(committedPreflightImplementationFiles)};`,
    "const realpathSync=fs.realpathSync.native||fs.realpathSync;",
    "const gitEnvironment={};",
    "const inherited=new Set(['COMSPEC','LANG','LC_ALL','LC_CTYPE','PATH','PATHEXT','SYSTEMROOT','TEMP','TMP','TMPDIR','WINDIR']);",
    "for(const [key,value] of Object.entries(process.env)){if(inherited.has(key.toUpperCase())&&typeof value==='string')gitEnvironment[key]=value;}",
    "Object.assign(gitEnvironment,{GIT_ATTR_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':os.devNull,GIT_CONFIG_NOSYSTEM:'1',GIT_OPTIONAL_LOCKS:'0',GIT_NO_LAZY_FETCH:'1',GIT_NO_REPLACE_OBJECTS:'1',GIT_PROTOCOL_FROM_USER:'0',GIT_TERMINAL_PROMPT:'0'});",
    "const prefix=['--no-pager','--no-optional-locks','--no-replace-objects','-c','core.fsmonitor=false','-c','safe.directory='+realpathSync(process.cwd())];",
    "const runGit=(command,extra={encoding:'utf8'})=>childProcess.execFileSync('git',[...prefix,...command],{cwd:process.cwd(),windowsHide:true,env:gitEnvironment,maxBuffer:16*1024*1024,...extra});",
    'function captureTree(){',
    "  runGit(['rev-parse','--show-toplevel']);",
    "  const commit=runGit(['rev-parse','--verify','HEAD^{commit}']).slice(0,-1);",
    "  runGit(['ls-files','--stage','-z','--',...implementationFiles]);",
    "  const tree=runGit(['ls-tree','-r','-z','--full-tree',commit,'--',...implementationFiles]);",
    "  const oids=tree.split('\\0').filter(Boolean).map(record=>record.split(/[ \\t]/)[2]);",
    '  return {commit,oids};',
    '}',
    'async function expectRejected(work){',
    '  try{await work();process.exitCode=11;}',
    "  catch(error){if(error.code!=='SYNTHETIC_PREFLIGHT_OFFLINE_FORBIDDEN')process.exitCode=12;}",
    '}',
    '(async()=>{',
    "const attack=process.env.GUARD_TEST_ATTACK;",
    "if(attack==='out_of_order'){const input=('a'.repeat(40)+'\\n').repeat(implementationFiles.length);await expectRejected(()=>runGit(['cat-file','--batch'],{encoding:null,input}));}",
    "else if(attack==='dynamic_import'){await expectRejected(()=>import /* synthetic bypass probe */ ('node:sqlite'));}",
    'else{',
    '  const {commit,oids}=captureTree();',
    "  if(attack==='wrong_oid'){const changed=oids.slice();changed[0]=commit;await expectRejected(()=>runGit(['cat-file','--batch'],{encoding:null,input:changed.join('\\n')+'\\n'}));}",
    "  else if(attack==='permuted'){const changed=oids.slice();const distinct=changed.findIndex((oid,index)=>index>0&&oid!==changed[0]);if(distinct<0){process.exitCode=13;}else{[changed[0],changed[distinct]]=[changed[distinct],changed[0]];await expectRejected(()=>runGit(['cat-file','--batch'],{encoding:null,input:changed.join('\\n')+'\\n'}));}}",
    "  else if(attack==='repeated'){const input=oids.join('\\n')+'\\n';runGit(['cat-file','--batch'],{encoding:null,input});await expectRejected(()=>runGit(['cat-file','--batch'],{encoding:null,input}));}",
    '  else process.exitCode=14;',
    '}',
    "if(!process.exitCode)process.stdout.write('guard state machine rejected '+attack+'\\n');",
    "})().catch(()=>{process.exitCode=15;});"
  ].join('\n');

  for (const attack of ['out_of_order', 'wrong_oid', 'permuted', 'repeated', 'dynamic_import']) {
    const verificationRoot = fs.mkdtempSync(path.join(
      os.tmpdir(),
      'tangguan-synthetic-api-preflight-verification-'
    ));
    const output = path.join(verificationRoot, 'evidence');
    try {
      const result = spawnSync(process.execPath, ['--require', guard, '-e', program], {
        cwd: projectRoot,
        env: {
          ...process.env,
          TANGGUAN_PREFLIGHT_GUARD_ROOT: verificationRoot,
          TANGGUAN_PREFLIGHT_GUARD_OUTPUT: output,
          GUARD_TEST_ATTACK: attack
        },
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15000
      });
      assert.equal(result.status, 0, `${attack}: ${result.stderr}`);
      assert.equal(result.stdout, `guard state machine rejected ${attack}\n`);
      assert.equal(result.stderr, '');
      assert.deepEqual(fs.readdirSync(verificationRoot), []);
    } finally {
      if (fs.existsSync(verificationRoot)
          && fs.lstatSync(verificationRoot).isDirectory()
          && !fs.lstatSync(verificationRoot).isSymbolicLink()
          && fs.readdirSync(verificationRoot).length === 0) {
        fs.rmdirSync(verificationRoot);
      }
    }
  }
});

test('committed preflight verifier 不执行 PATH 中的临时假 Git', {
  skip: process.platform !== 'win32'
}, () => {
  const fakeDirectory = fs.mkdtempSync(path.join(tempRoot, 'preflight-fake-git-'));
  const fakeGit = path.join(fakeDirectory, 'git.exe');
  fs.writeFileSync(fakeGit, 'synthetic non-executable sentinel', { flag: 'wx' });
  try {
    const result = spawnSync(process.execPath, [
      path.join(projectRoot, 'scripts', 'verify-synthetic-api-preflight.js')
    ], {
      cwd: projectRoot,
      env: {
        ...process.env,
        PATH: `${fakeDirectory}${path.delimiter}${process.env.PATH}`
      },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'Synthetic API committed preflight verification passed.\n');
    assert.equal(result.stderr, '');
    assert.equal(fs.readFileSync(fakeGit, 'utf8'), 'synthetic non-executable sentinel');
  } finally {
    if (fs.existsSync(fakeGit)
        && fs.lstatSync(fakeGit).isFile()
        && !fs.lstatSync(fakeGit).isSymbolicLink()
        && fs.lstatSync(fakeGit).nlink === 1) {
      fs.unlinkSync(fakeGit);
    }
    if (fs.existsSync(fakeDirectory)
        && fs.lstatSync(fakeDirectory).isDirectory()
        && !fs.lstatSync(fakeDirectory).isSymbolicLink()
        && fs.readdirSync(fakeDirectory).length === 0) {
      fs.rmdirSync(fakeDirectory);
    }
  }
});

test('committed preflight verifier 对证据 schema 与值精确 fail closed', () => {
  const environment = syntheticEnvironment();
  const expected = fakeProvenance();
  const evidence = preflight.evidenceFor(environment, expected);
  const boundaries = {
    temporaryRoot: tempRoot,
    realTemporaryRoot: fs.realpathSync(tempRoot),
    verificationRoot: path.join(tempRoot, 'verification-root'),
    realVerificationRoot: path.join(tempRoot, 'verification-root'),
    output: path.join(tempRoot, 'verification-root', 'evidence')
  };
  assert.doesNotThrow(() => committedPreflightVerifier.assertEvidenceForTest(
    evidence,
    `${JSON.stringify(evidence, null, 2)}\n`,
    expected,
    environment,
    boundaries
  ));

  const emptyExternal = structuredClone(evidence);
  emptyExternal.externalVerification = {};
  assert.throws(
    () => committedPreflightVerifier.assertEvidenceForTest(
      emptyExternal,
      `${JSON.stringify(emptyExternal, null, 2)}\n`,
      expected,
      environment,
      boundaries
    ),
    error => error && error.code === 'EVIDENCE_SCHEMA_INVALID'
  );

  const selfHashedEmptyConfiguration = structuredClone(evidence);
  selfHashedEmptyConfiguration.configuration = {};
  selfHashedEmptyConfiguration.configurationSha256 = sha256(Buffer.from('{}', 'utf8'));
  assert.throws(
    () => committedPreflightVerifier.assertEvidenceForTest(
      selfHashedEmptyConfiguration,
      `${JSON.stringify(selfHashedEmptyConfiguration, null, 2)}\n`,
      expected,
      environment,
      boundaries
    ),
    error => error && error.code === 'EVIDENCE_SCHEMA_INVALID'
  );

  const extraClaim = structuredClone(evidence);
  extraClaim.unverifiedDeploymentClaim = false;
  assert.throws(
    () => committedPreflightVerifier.assertEvidenceForTest(
      extraClaim,
      `${JSON.stringify(extraClaim, null, 2)}\n`,
      expected,
      environment,
      boundaries
    ),
    error => error && error.code === 'PROVENANCE_MISMATCH'
  );

  const canonical = `${JSON.stringify(evidence, null, 2)}\n`;
  const duplicateKeyLeak = canonical.replace(
    '  "profile":',
    `  "profile": ${JSON.stringify(environment.WX_APPSECRET)},\n  "profile":`
  );
  assert.throws(
    () => committedPreflightVerifier.assertEvidenceForTest(
      JSON.parse(duplicateKeyLeak),
      duplicateKeyLeak,
      expected,
      environment,
      boundaries
    ),
    error => error && error.code === 'PROVENANCE_MISMATCH'
  );
});

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('synthetic 配置总门只返回无秘密的规范化运行契约', () => {
  const environment = syntheticEnvironment();
  const result = profile.validateSyntheticDeployment(environment, { projectRoot });
  assert.equal(result.deploymentTier, 'synthetic');
  assert.equal(result.apiOrigin, environment.API_PUBLIC_ORIGIN);
  assert.equal(result.wechatAppId, environment.WX_APPID);
  assert.equal(result.wechatSecretPresent, true);
  assert.equal(result.coreFeatureGatesEnabled, true);
  assert.equal(result.closedFeatureGatesDisabled, true);
  assert.equal(result.proxyPolicy.mode, 'direct');
  assert.equal(result.proxyPolicy.trustedProxyCount, 0);
  assert.equal(Object.values(result).includes(environment.WX_APPSECRET), false);
});

test('synthetic profile、三项人工确认和生产形态必须精确拒绝', () => {
  assertCode(
    () => profile.validateSyntheticDeployment(syntheticEnvironment({ NODE_ENV: 'test' }), {
      projectRoot
    }),
    'SYNTHETIC_MODE_REQUIRED'
  );
  for (const name of [
    'SYNTHETIC_RUNTIME_ACK',
    'SYNTHETIC_APP_CREDENTIALS_ACK',
    'SYNTHETIC_DATA_ACK'
  ]) {
    assertCode(
      () => profile.validateSyntheticDeployment(syntheticEnvironment({ [name]: '' }), {
        projectRoot
      }),
      'SYNTHETIC_ACK_REQUIRED'
    );
  }
  assertCode(
    () => profile.validateSyntheticDeployment(syntheticEnvironment({
      WX_APPID: profile.PRODUCTION_WECHAT_APP_ID
    }), { projectRoot }),
    'SYNTHETIC_PRODUCTION_RESOURCE_FORBIDDEN'
  );
  assertCode(
    () => profile.validateSyntheticDeployment(syntheticEnvironment({ WX_APPSECRET: '' }), {
      projectRoot
    }),
    'SYNTHETIC_CONFIG_INVALID'
  );
});

test('API 与法律源拒绝生产等价写法、跨源和非 canonical URL', () => {
  for (const origin of [
    'https://hefeijifen.cn',
    'https://preview.hefeijifen.cn',
    'https://HEFEIJIFEN.cn',
    'https://hefeijifen.cn:443',
    'https://user@synthetic-api.example.com',
    'https://synthetic-api.example.com/',
    'https://synthetic-api.example.com/path',
    'https://127.0.0.1',
    'https://synthetic-api.invalid'
  ]) {
    const expectedCode = origin.toLowerCase().includes('hefeijifen.cn')
      && profile.canonicalPublicHttpsOrigin(origin)
      ? 'SYNTHETIC_PRODUCTION_RESOURCE_FORBIDDEN'
      : 'SYNTHETIC_CONFIG_INVALID';
    assertCode(
      () => profile.validateSyntheticDeployment(syntheticEnvironment({
        API_PUBLIC_ORIGIN: origin
      }), { projectRoot }),
      expectedCode
    );
  }
  assertCode(
    () => profile.validateSyntheticDeployment(syntheticEnvironment({
      LEGAL_PUBLIC_ORIGIN: 'https://other-synthetic.example.com'
    }), { projectRoot }),
    'SYNTHETIC_LEGAL_SOURCE_INVALID'
  );
  assertCode(
    () => profile.validateSyntheticDeployment(syntheticEnvironment({
      GUARDIAN_RELATION_DECLARATION_PUBLIC_URL: 'https://synthetic-api.example.com/legal/wrong'
    }), { projectRoot }),
    'SYNTHETIC_LEGAL_SOURCE_INVALID'
  );
});

test('核心四门必须字面开启且数据权利与 legacy 三门必须字面关闭', () => {
  for (const name of profile.CORE_SYNTHETIC_GATES) {
    for (const value of ['', 'false', '1', 'TRUE']) {
      assertCode(
        () => profile.validateSyntheticDeployment(syntheticEnvironment({ [name]: value }), {
          projectRoot
        }),
        'SYNTHETIC_FEATURE_GATES_INVALID'
      );
    }
  }
  for (const name of profile.CLOSED_SYNTHETIC_GATES) {
    for (const value of ['', 'true', '0', 'FALSE']) {
      assertCode(
        () => profile.validateSyntheticDeployment(syntheticEnvironment({ [name]: value }), {
          projectRoot
        }),
        'SYNTHETIC_FEATURE_GATES_INVALID'
      );
    }
  }
});

test('synthetic 数据根拒绝相对、仓库、父目录、别名文件名和迁移清单', () => {
  const unsafe = [
    { SYNTHETIC_DATA_ROOT: 'relative-synthetic-root' },
    {
      SYNTHETIC_DATA_ROOT: path.join(projectRoot, 'tangguan-synthetic-stage1'),
      DATA_DIR: path.join(projectRoot, 'tangguan-synthetic-stage1', 'data'),
      SQLITE_FILE: path.join(
        projectRoot, 'tangguan-synthetic-stage1', 'data', 'hefei-points-synthetic.sqlite'
      )
    },
    {
      SYNTHETIC_DATA_ROOT: path.dirname(projectRoot),
      DATA_DIR: path.join(path.dirname(projectRoot), 'data'),
      SQLITE_FILE: path.join(path.dirname(projectRoot), 'data', 'hefei-points-synthetic.sqlite')
    },
    { SQLITE_FILE: path.join(tempRoot, 'tangguan-synthetic-stage1', 'data', 'production.sqlite') },
    { PRE_MIGRATION_BACKUP_MANIFEST: path.join(tempRoot, 'production-manifest.json') }
  ];
  if (process.platform === 'win32') {
    unsafe.push({
      SYNTHETIC_DATA_ROOT: '\\\\synthetic-host\\share\\tangguan-synthetic-stage1'
    });
  }
  for (const overrides of unsafe) {
    assertCode(
      () => profile.validateSyntheticDeployment(syntheticEnvironment(overrides), { projectRoot }),
      'SYNTHETIC_DATA_ROOT_UNSAFE'
    );
  }
});

test('synthetic 运行数据根要求无链接物理目录、严格 marker 与普通 SQLite 文件', t => {
  const environment = syntheticEnvironment();
  const deployment = createPhysicalSyntheticRoot(environment);
  const markerFile = path.join(
    deployment.dataPaths.root,
    runtimeFilesystem.SYNTHETIC_DATA_MARKER_FILENAME
  );
  assert.match(
    runtimeFilesystem.validateSyntheticRuntimeFilesystem(deployment, projectRoot).markerSha256,
    /^[0-9a-f]{64}$/
  );

  fs.writeFileSync(deployment.dataPaths.sqliteFile, Buffer.alloc(0), { flag: 'wx' });
  assert.doesNotThrow(() => runtimeFilesystem.validateSyntheticRuntimeFilesystem(
    deployment,
    projectRoot
  ));
  fs.writeFileSync(markerFile, '{}\n');
  assertRuntimeCode(() => runtimeFilesystem.validateSyntheticRuntimeFilesystem(
    deployment,
    projectRoot
  ));
  fs.writeFileSync(markerFile, runtimeFilesystem.markerBufferFor(deployment));

  for (const unexpected of [
    path.join(deployment.dataPaths.root, 'config.json'),
    `${deployment.dataPaths.sqliteFile}-journal`
  ]) {
    fs.writeFileSync(unexpected, 'synthetic-unexpected-file');
    assertRuntimeCode(() => runtimeFilesystem.validateSyntheticRuntimeFilesystem(
      deployment,
      projectRoot
    ));
    fs.unlinkSync(unexpected);
  }
  const unexpectedBackup = path.join(deployment.dataPaths.root, 'backups');
  fs.mkdirSync(unexpectedBackup);
  assertRuntimeCode(() => runtimeFilesystem.validateSyntheticRuntimeFilesystem(
    deployment,
    projectRoot
  ));
  fs.rmdirSync(unexpectedBackup);

  fs.unlinkSync(deployment.dataPaths.sqliteFile);
  fs.mkdirSync(deployment.dataPaths.sqliteFile);
  assertRuntimeCode(() => runtimeFilesystem.validateSyntheticRuntimeFilesystem(
    deployment,
    projectRoot
  ));
  fs.rmdirSync(deployment.dataPaths.sqliteFile);

  const missingEnvironment = syntheticEnvironment({
    SYNTHETIC_DATASET_ID: 'synthetic-no-marker',
    SYNTHETIC_DATA_ROOT: path.join(tempRoot, 'tangguan-synthetic-no-marker'),
    DATA_DIR: path.join(tempRoot, 'tangguan-synthetic-no-marker', 'data'),
    SQLITE_FILE: path.join(
      tempRoot, 'tangguan-synthetic-no-marker', 'data', 'hefei-points-synthetic.sqlite'
    )
  });
  const missingDeployment = profile.validateSyntheticDeployment(missingEnvironment, { projectRoot });
  fs.mkdirSync(missingDeployment.dataPaths.dataDir, { recursive: true });
  assertRuntimeCode(() => runtimeFilesystem.validateSyntheticRuntimeFilesystem(
    missingDeployment,
    projectRoot
  ));

  const aliasRoot = path.join(tempRoot, 'tangguan-synthetic-linked-root');
  const aliasEnvironment = syntheticEnvironment({
    SYNTHETIC_DATASET_ID: 'synthetic-linked-root',
    SYNTHETIC_DATA_ROOT: aliasRoot,
    DATA_DIR: path.join(aliasRoot, 'data'),
    SQLITE_FILE: path.join(aliasRoot, 'data', 'hefei-points-synthetic.sqlite')
  });
  const aliasDeployment = profile.validateSyntheticDeployment(aliasEnvironment, { projectRoot });
  const physicalTarget = path.join(tempRoot, 'synthetic-linked-physical-target');
  fs.mkdirSync(path.join(physicalTarget, 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(physicalTarget, runtimeFilesystem.SYNTHETIC_DATA_MARKER_FILENAME),
    runtimeFilesystem.markerBufferFor(aliasDeployment),
    { flag: 'wx' }
  );
  try {
    fs.symlinkSync(physicalTarget, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (!error || !['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error;
    t.diagnostic('junction/symlink creation is unavailable; static link rejection remains covered');
    return;
  }
  assertRuntimeCode(() => runtimeFilesystem.validateSyntheticRuntimeFilesystem(
    aliasDeployment,
    projectRoot
  ));
});

test('synthetic runtime 首次启动与重启只创建合成默认家庭、SQLite 和独立 secret', () => {
  const root = path.join(tempRoot, 'tangguan-synthetic-runtime-spawn');
  const environment = syntheticEnvironment({
    SYNTHETIC_DATASET_ID: 'synthetic-runtime-spawn',
    SYNTHETIC_DATA_ROOT: root,
    DATA_DIR: path.join(root, 'data'),
    SQLITE_FILE: path.join(root, 'data', 'hefei-points-synthetic.sqlite'),
    LOG_LEVEL: 'error'
  });
  createPhysicalSyntheticRoot(environment);
  const program = [
    "const fs=require('node:fs');",
    "const path=require('node:path');",
    "const {installLoopbackOnlyNetwork}=require('./server/test-support/loopback-only-network');",
    'const restore=installLoopbackOnlyNetwork();',
    'let server;',
    'let closeDb=()=>{};',
    '(async()=>{',
    'try {',
    "  const {createApp}=require('./server/index');",
    '  const app=createApp();',
    "  const connection=require('./server/db/connection');",
    '  closeDb=connection.closeDb;',
    '  const {getDb}=connection;',
    "  const family=getDb().prepare(\"SELECT name FROM families WHERE id='default'\").get();",
    "  if(!family||family.name!=='合成默认家庭')process.exitCode=11;",
    "  const repositories=require('./server/db/repositories');",
    "  const token=require('./server/lib/token');",
    "  if(!repositories.users.findById('synthetic_admin'))repositories.users.insert({id:'synthetic_admin',name:'合成管理员',role:'admin',familyId:'default'});",
    "  const headers={Authorization:'Bearer '+token.signToken('synthetic_admin','admin','default')};",
    "  const secret=fs.readFileSync(path.join(process.env.DATA_DIR,'.secret'),'utf8');",
    "  if(!/^[0-9a-f]{64}$/.test(secret))process.exitCode=12;",
    "  if(fs.existsSync(path.join(process.env.SYNTHETIC_DATA_ROOT,'backups')))process.exitCode=13;",
    "  if(fs.existsSync(path.join(process.env.DATA_DIR,'config.json')))process.exitCode=14;",
    "  server=await new Promise((resolve,reject)=>{const value=app.listen(0,'127.0.0.1');value.once('listening',()=>resolve(value));value.once('error',reject);});",
    "  const base='http://127.0.0.1:'+server.address().port;",
    "  const anonymousList=await fetch(base+'/api/backups');",
    "  if(anonymousList.status!==403)process.exitCode=15;",
    "  const listed=await fetch(base+'/api/backups',{headers});",
    '  const listBody=await listed.json();',
    "  if(listed.status!==200||!listBody.success||listBody.backups.length!==0)process.exitCode=16;",
    "  const anonymousCreate=await fetch(base+'/api/backup',{method:'POST'});",
    "  if(anonymousCreate.status!==403)process.exitCode=17;",
    "  const created=await fetch(base+'/api/backup',{method:'POST',headers});",
    '  if(created.status!==409)process.exitCode=18;',
    '} finally {',
    '  if(server)await new Promise(resolve=>server.close(resolve));',
    '  closeDb();',
    '  restore();',
    '}',
    '})().catch(()=>{process.exitCode=20;});'
  ].join('\n');
  for (let run = 0; run < 2; run += 1) {
    const result = spawnSync(process.execPath, ['-e', program], {
      cwd: projectRoot,
      env: { ...process.env, ...environment },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20000
    });
    assert.equal(result.status, 0, result.stderr);
  }
  const secretFile = path.join(environment.DATA_DIR, '.secret');
  const secretMetadata = fs.lstatSync(secretFile);
  assert.ok(secretMetadata.isFile() && !secretMetadata.isSymbolicLink());
  assert.equal(secretMetadata.nlink, 1);
  assert.match(fs.readFileSync(secretFile, 'utf8'), /^[0-9a-f]{64}$/);
  assert.equal(fs.existsSync(path.join(root, 'backups')), false);
  assert.equal(fs.existsSync(path.join(environment.DATA_DIR, 'config.json')), false);
});

test('配对地址策略只接受 direct 空代理或显式 IP/CIDR allowlist', () => {
  assertCode(
    () => profile.validateSyntheticDeployment(syntheticEnvironment({
      TRUSTED_PROXIES: '127.0.0.1/32'
    }), { projectRoot }),
    'SYNTHETIC_PROXY_POLICY_INVALID'
  );
  const proxied = profile.validateSyntheticDeployment(syntheticEnvironment({
    PAIRING_CLIENT_IP_MODE: 'trusted_proxy',
    TRUSTED_PROXIES: '127.0.0.1/32,::1/128'
  }), { projectRoot });
  assert.equal(proxied.proxyPolicy.mode, 'trusted_proxy');
  assert.equal(proxied.proxyPolicy.trustedProxyCount, 2);
  for (const proxies of [
    '', '*', 'loopback', '127.0.0.1/99', '0.0.0.0/0', '::/0',
    '192.0.2.0/23', '2001:db8::/63', '224.0.0.1', 'ff02::1',
    '::ffff:0:0/96', '0:0:0:0:0:ffff:0:0/96', '::ffff:192.0.2.1/128',
    '0:0:0:0:0:0:0:0/64', '::1/64', '::abcd/64'
  ]) {
    assertCode(
      () => profile.validateSyntheticDeployment(syntheticEnvironment({
        PAIRING_CLIENT_IP_MODE: 'trusted_proxy',
        TRUSTED_PROXIES: proxies
      }), { projectRoot }),
      'SYNTHETIC_PROXY_POLICY_INVALID'
    );
  }
});

test('production tier 不能混入 synthetic 标记且公开身份必须精确', () => {
  const production = {
    NODE_ENV: 'production',
    DEPLOYMENT_TIER: 'production',
    API_PUBLIC_ORIGIN: profile.PRODUCTION_API_ORIGIN,
    WX_APPID: profile.PRODUCTION_WECHAT_APP_ID,
    ...Object.fromEntries(profile.PRODUCTION_LOCKED_CHILD_GATES.map(name => [name, 'false']))
  };
  assert.equal(profile.validateDeployment(production).deploymentTier, 'production');
  assertCode(
    () => profile.validateDeployment({ ...production, DEPLOYMENT_TIER: '' }),
    'DEPLOYMENT_TIER_REQUIRED'
  );
  assertCode(
    () => profile.validateDeployment({ ...production, SYNTHETIC_DATA_ACK: profile.SYNTHETIC_DATA_ACK }),
    'PRODUCTION_CONFIG_INVALID'
  );
  for (const name of profile.PRODUCTION_LOCKED_CHILD_GATES) {
    for (const value of [undefined, '0', 'FALSE', '1', 'true']) {
      assertCode(
        () => profile.validateDeployment({ ...production, [name]: value }),
        'PRODUCTION_CHILD_FEATURES_LOCKED'
      );
    }
  }
  for (const name of profile.PRODUCTION_LOCKED_LEGAL_CONFIG) {
    assertCode(
      () => profile.validateDeployment({ ...production, [name]: 'synthetic-not-approved' }),
      'PRODUCTION_LEGAL_FEATURES_LOCKED'
    );
  }
  assertCode(
    () => profile.validateDeployment({ ...production, API_PUBLIC_ORIGIN: 'https://example.com' }),
    'PRODUCTION_CONFIG_INVALID'
  );
  assertCode(
    () => profile.validateDeployment({ ...production, WX_APPID: 'wx0123456789abcdef' }),
    'PRODUCTION_CONFIG_INVALID'
  );
  assertCode(
    () => profile.validateDeployment({ ...production, NODE_ENV: 'prod' }),
    'DEPLOYMENT_TIER_INVALID'
  );
  assertCode(
    () => profile.validateDeployment({ NODE_ENV: 'test', DEPLOYMENT_TIER: 'synthetic' }),
    'DEPLOYMENT_TIER_INVALID'
  );
});

test('env loader 拒绝未知 NODE_ENV 且非生产不能声明 production/synthetic tier', () => {
  for (const environment of [
    { NODE_ENV: 'prod', DEPLOYMENT_TIER: 'production' },
    { NODE_ENV: 'production ', DEPLOYMENT_TIER: 'production' },
    { NODE_ENV: 'test', DEPLOYMENT_TIER: 'synthetic' }
  ]) {
    const result = spawnSync(process.execPath, ['-e', "require('./server/config/env')"], {
      cwd: projectRoot,
      env: { ...process.env, ...environment },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000
    });
    assert.notEqual(result.status, 0);
  }
});

test('离线 preflight 只原子发布无密配置形状证据', () => {
  const environment = syntheticEnvironment();
  const output = path.join(tempRoot, 'synthetic-api-preflight-evidence');
  assert.deepEqual(preflight.parseArguments(['--output', output]), {
    output,
    help: false
  });
  assert.equal(
    preflight.prepareEvidence({ output }, environment, fakeProvenance),
    output
  );
  const evidenceFile = path.join(output, '.synthetic-api-preflight.json');
  const raw = fs.readFileSync(evidenceFile, 'utf8');
  const evidence = JSON.parse(raw);
  assert.equal(evidence.schemaVersion, 3);
  assert.equal(evidence.profile, 'synthetic-api-offline-preflight');
  assert.equal(evidence.result, 'configuration-shape-validated');
  assert.equal(evidence.sourceCommit, 'a'.repeat(40));
  assert.equal(evidence.implementationIndexMatchesHead, true);
  assert.equal(evidence.implementationWorktreeMatchesHeadAfterEolNormalization, true);
  assert.equal(evidence.configuration.wechatSecretPresent, true);
  assert.equal(
    evidence.configuration.apiOriginSha256,
    sha256(Buffer.from(environment.API_PUBLIC_ORIGIN, 'utf8'))
  );
  assert.equal(
    evidence.configuration.wechatAppIdSha256,
    sha256(Buffer.from(environment.WX_APPID, 'utf8'))
  );
  assert.deepEqual(evidence.productionChildGate, {
    deployedStateVerified: false,
    changeAttempted: false
  });
  for (const value of Object.values(evidence.externalVerification)) assert.equal(value, false);
  for (const forbidden of [
    environment.API_PUBLIC_ORIGIN,
    environment.WX_APPID,
    environment.WX_APPSECRET,
    environment.SYNTHETIC_DATA_ROOT,
    environment.DATA_DIR,
    environment.SQLITE_FILE,
    environment.GUARDIAN_RELATION_DECLARATION_PUBLIC_URL
  ]) assert.equal(raw.includes(forbidden), false, forbidden);
  assert.deepEqual(fs.readdirSync(output), ['.synthetic-api-preflight.json']);
  for (const forbiddenModule of [
    `${path.sep}server${path.sep}index.js`,
    `${path.sep}server${path.sep}db${path.sep}connection.js`,
    `${path.sep}server${path.sep}lib${path.sep}wx-auth.js`
  ]) {
    assert.equal(Object.keys(require.cache).some(filename => filename.endsWith(forbiddenModule)), false);
  }
});

test('离线 preflight 在发布前再次拒绝 provenance 漂移并清理 staging', () => {
  const output = path.join(tempRoot, 'synthetic-api-preflight-provenance-drift');
  let calls = 0;
  const driftingProvenance = () => ({
    ...fakeProvenance(),
    sourceCommit: (calls += 1) === 1 ? 'a'.repeat(40) : 'd'.repeat(40)
  });
  assert.throws(
    () => preflight.prepareEvidence({ output }, syntheticEnvironment(), driftingProvenance),
    /changed before evidence publication/
  );
  assert.equal(fs.existsSync(output), false);
  assert.equal(
    fs.readdirSync(tempRoot).some(name => name.startsWith('.tangguan-api-preflight-stage-')),
    false
  );
});

test('离线 preflight 顶层 TEMP 失败只返回稳定脱敏错误', () => {
  const sentinel = path.join(tempRoot, 'private-temp-sentinel-does-not-exist');
  const result = spawnSync(process.execPath, [
    path.join(projectRoot, 'scripts', 'preflight-synthetic-api.js'),
    '--output',
    path.join(sentinel, 'synthetic-preflight-output')
  ], {
    cwd: projectRoot,
    env: { ...process.env, TEMP: sentinel, TMP: sentinel },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^Synthetic API offline preflight failed \([A-Z0-9_]+\)\.\r?\n$/);
  assert.equal(result.stderr.includes(sentinel), false);
  assert.equal(result.stderr.includes(projectRoot), false);
});

test('离线 preflight 写入失败不留下最终目录或 staging', () => {
  const output = path.join(tempRoot, 'synthetic-api-preflight-failure');
  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = function(filename, ...args) {
    if (path.basename(String(filename)) === '.synthetic-api-preflight.json') {
      throw new Error('synthetic injected evidence failure');
    }
    return originalWrite.call(fs, filename, ...args);
  };
  try {
    assert.throws(
      () => preflight.prepareEvidence({ output }, syntheticEnvironment(), fakeProvenance),
      /synthetic injected evidence failure/
    );
  } finally {
    fs.writeFileSync = originalWrite;
  }
  assert.equal(fs.existsSync(output), false);
  assert.equal(
    fs.readdirSync(tempRoot).some(name => name.startsWith('.tangguan-api-preflight-stage-')),
    false
  );
});

test('离线 preflight 原子 rename 是成功路径最后文件系统操作', () => {
  const output = path.join(tempRoot, 'synthetic-api-preflight-atomic');
  const originals = new Map();
  let published = false;
  const originalRename = fs.renameSync;
  fs.renameSync = function(from, to) {
    if (published) throw new Error('post-publish filesystem operation: renameSync');
    const result = originalRename.call(fs, from, to);
    if (path.resolve(String(to)) === path.resolve(output)) published = true;
    return result;
  };
  for (const name of [
    'existsSync', 'lstatSync', 'statSync', 'readFileSync', 'readdirSync', 'realpathSync',
    'writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'copyFileSync',
    'chmodSync', 'openSync'
  ]) {
    const original = fs[name];
    originals.set(name, original);
    fs[name] = function(filename, ...args) {
      if (published) throw new Error(`post-publish filesystem operation: ${name}`);
      return original.call(fs, filename, ...args);
    };
  }
  try {
    assert.equal(
      preflight.prepareEvidence({ output }, syntheticEnvironment(), fakeProvenance),
      output
    );
    assert.equal(published, true);
  } finally {
    fs.renameSync = originalRename;
    for (const [name, original] of originals) fs[name] = original;
  }
  assert.equal(fs.existsSync(path.join(output, '.synthetic-api-preflight.json')), true);
});

test('微信认证不再读取根 .env 或继承 synthetic 缺失 secret', () => {
  const guard = path.join(tempRoot, 'deny-private-env-read.cjs');
  fs.writeFileSync(guard, [
    "const fs = require('node:fs');",
    'for (const name of [\'existsSync\', \'readFileSync\']) {',
    '  const original = fs[name];',
    '  fs[name] = function(filename, ...args) {',
    "    if (/(?:^|[\\\\/])\\.env(?:$|\.)/i.test(String(filename))) throw new Error('PRIVATE_ENV_READ');",
    '    return original.call(fs, filename, ...args);',
    '  };',
    '}'
  ].join('\n'));
  const environment = { ...process.env, NODE_ENV: 'test' };
  delete environment.WX_APPID;
  delete environment.WX_APPSECRET;
  const result = spawnSync(process.execPath, [
    '--require', guard,
    '-e',
    "const wx=require('./server/lib/wx-auth');"
      + "if(wx.WX_APPSECRET!==''||wx.WX_APPID!=='')process.exit(7);"
  ], {
    cwd: projectRoot,
    env: environment,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000
  });
  assert.equal(result.status, 0, result.stderr);
});
