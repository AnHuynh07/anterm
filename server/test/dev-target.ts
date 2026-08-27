/**
 * Standalone SSH target for local manual testing (no Docker / system sshd needed).
 *
 *   npx tsx server/test/dev-target.ts [port]            # plain shell (demo / demo)
 *   npx tsx server/test/dev-target.ts [port] --device   # emulates a network device
 *                                                        # SSH svc/svc, login netadmin/l0gin, enable en4ble
 *
 * Then add a connection in AnTerm pointing at 127.0.0.1:<port>.
 */
import { startSshFixture } from './sshFixture.js';
import { startDeviceFixture } from './deviceFixture.js';

const args = process.argv.slice(2);
const device = args.includes('--device');
const port = Number(args.find((a) => /^\d+$/.test(a)) ?? (device ? 2223 : 2222));

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
