/**
 * Standalone target for local manual testing (no Docker / system sshd needed).
 *
 *   npx tsx server/test/dev-target.ts [port]            # plain shell (demo / demo)
 *   npx tsx server/test/dev-target.ts [port] --device   # emulates a network device
 *                                                        # SSH svc/svc, login netadmin/l0gin, enable en4ble
 *   npx tsx server/test/dev-target.ts [port] --switch    # emulates a web-only switch
 *                                                        # web login manager / friend, config at /iss/backup.cfg
 *
 * Then add a connection in AnTerm pointing at 127.0.0.1:<port>.
 */
import { startSshFixture } from './sshFixture.js';
import { startDeviceFixture } from './deviceFixture.js';
import { startWebSwitchFixture } from './webSwitchFixture.js';

const args = process.argv.slice(2);
const device = args.includes('--device');
const web = args.includes('--switch');
const port = Number(args.find((a) => /^\d+$/.test(a)) ?? (web ? 8080 : device ? 2223 : 2222));

if (web) {
  const s = await startWebSwitchFixture({ port });
  console.log(`\n  Dev WEB SWITCH target on ${s.url.replace(/\/$/, '')}  (running on :${s.port})`);
  console.log(`    web login    : ${s.user} / ${s.pass}`);
  console.log(`    config backup: /iss/backup.cfg`);
  console.log(`    device info  : /iss/sysinfo.htm   (firmware ${s.firmware})`);
  console.log(`\n  In AnTerm: New connection → protocol "Web (HTTP)", URL http://127.0.0.1:${s.port}/,`);
  console.log(`  username ${s.user}, password ${s.pass}, config backup URL /iss/backup.cfg,`);
  console.log(`  device-info URL /iss/sysinfo.htm, expected firmware ${s.firmware}\n`);
  console.log('  Ctrl+C to stop.\n');
  const stop = () => void s.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} else {
  const server = device
    ? await startDeviceFixture({ port })
    : await startSshFixture({ username: 'demo', password: 'demo', port });

  if (device) {
    const d = server as Awaited<ReturnType<typeof startDeviceFixture>>;
    console.log(`\n  Dev NETWORK DEVICE target on 127.0.0.1:${d.port}`);
    console.log(`    SSH login    : ${d.sshUser} / ${d.sshPass}`);
    console.log(`    device login : ${d.loginUser} / ${d.loginPass}`);
    console.log(`    enable secret: ${d.enablePass}\n`);
  } else {
    const s = server as Awaited<ReturnType<typeof startSshFixture>>;
    console.log(`\n  Dev SSH shell target on 127.0.0.1:${s.port}  (user ${s.username} / pass ${s.password})\n`);
  }
  console.log('  Ctrl+C to stop.\n');

  const stop = () => void server.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
