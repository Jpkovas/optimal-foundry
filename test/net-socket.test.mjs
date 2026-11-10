import { test, before } from "node:test";
import assert from "node:assert/strict";
import { fakeFoundry, startNetwork } from "./net-harness.mjs";

/** The coordinator session lock between two sessions (tabs) of the same GM user. */
let w, socket;
const beats = () => w.sent.filter(s => s.msg.t === "core.coordBeat");

before(async () => {
  w = fakeFoundry();
  ({ socket } = await startNetwork());
});

test("socket: a closing session says goodbye with a plain broadcast", () => {
  // The regular beat is addressed to this user's own sessions.
  assert.deepEqual(beats().at(-1).msg.to, ["gm"]);
  assert.equal(beats().at(-1).args, 3, "emit(name, message, {recipients})");

  w.windowListeners.pagehide();
  const bye = beats().at(-1);
  assert.equal(bye.msg.p.bye, true);
  // While the world shuts down the server has no user list left: an emit with recipients throws there.
  assert.equal(bye.msg.to, undefined);
  assert.equal(bye.args, 2, "emit(name, message): no options argument at all");
});

test("socket: only this user's own sessions are believed, hello or goodbye", async () => {
  assert.equal(socket.isCoordinator(), true);
  await w.deliver("core.coordBeat", { sid: "older", startedAt: 1 }, "gm");
  assert.equal(socket.isCoordinator(), false, "an older session of the same GM coordinates");

  await w.deliver("core.coordBeat", { sid: "older", bye: true }, "u1");
  assert.equal(socket.isCoordinator(), false, "a broadcast goodbye from someone else changes nothing");

  await w.deliver("core.coordBeat", { sid: "older", bye: true }, "gm");
  assert.equal(socket.isCoordinator(), true);
});
