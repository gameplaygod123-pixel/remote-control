import { WebSocketServer, type WebSocket } from "ws";
import { SignalingMessage } from "@remote-control/protocol";
import { isValidAgentToken, hashPin, verifyPin } from "./auth.js";
import {
  registerAgent,
  getAgent,
  hasExceededAttempts,
  recordFailedAttempt,
  pairController,
  resolveRelayTarget,
  removeConnection,
  listDevices,
  subscribeToDeviceList,
  getSubscribedControllers,
  setDeviceName,
  setDeviceThumbnail,
  setPendingController,
  takePendingController,
  removeDevice,
} from "./pairing.js";

const port = Number(process.env.PORT ?? 8080);

const wss = new WebSocketServer({ port });

function send(ws: WebSocket, message: SignalingMessage): void {
  ws.send(JSON.stringify(message));
}

// How long a controller waits for a human at the agent to accept/reject
// before giving up -- covers the agent operator being away, not just a
// slow response.
const PENDING_APPROVAL_TIMEOUT_MS = 30_000;
const pendingTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

function clearPendingTimeout(deviceId: string): void {
  const timeout = pendingTimeouts.get(deviceId);
  if (timeout) {
    clearTimeout(timeout);
    pendingTimeouts.delete(deviceId);
  }
}

// Re-reads current agent state rather than taking online/name as params, so
// every caller (register, disconnect, rename) broadcasts the same
// single-source-of-truth snapshot instead of each having to know the full
// current state itself.
function broadcastDeviceUpdate(deviceId: string): void {
  const agent = getAgent(deviceId);
  if (!agent) return;
  for (const controllerWs of getSubscribedControllers()) {
    send(controllerWs, {
      type: "device-status-changed",
      deviceId,
      online: agent.online,
      name: agent.name,
    });
  }
}

wss.on("connection", (socket) => {
  console.log("client connected");

  socket.on("message", async (data) => {
    const parsed = SignalingMessage.safeParse(JSON.parse(data.toString()));
    if (!parsed.success) {
      console.warn("dropped invalid message:", parsed.error.message);
      return;
    }
    const message = parsed.data;

    switch (message.type) {
      case "register-agent": {
        if (!isValidAgentToken(message.token)) {
          send(socket, { type: "register-result", ok: false, reason: "invalid token" });
          socket.close();
          return;
        }
        const pinHash = await hashPin(message.pin);
        registerAgent(message.deviceId, socket, pinHash, message.name);
        send(socket, { type: "register-result", ok: true });
        broadcastDeviceUpdate(message.deviceId);
        console.log(`agent registered: ${message.deviceId}`);
        break;
      }

      case "set-device-name": {
        setDeviceName(message.deviceId, message.name);
        broadcastDeviceUpdate(message.deviceId);
        break;
      }

      case "device-thumbnail": {
        // Only the agent that actually owns this deviceId may update its
        // thumbnail -- cheap sanity check against a mismatched/rogue sender.
        const agent = getAgent(message.deviceId);
        if (!agent || agent.ws !== socket) break;
        setDeviceThumbnail(message.deviceId, message.image);
        for (const controllerWs of getSubscribedControllers()) {
          send(controllerWs, {
            type: "device-thumbnail",
            deviceId: message.deviceId,
            image: message.image,
          });
        }
        break;
      }

      case "pair-request": {
        const agent = getAgent(message.deviceId);
        if (!agent || !agent.online || !agent.ws) {
          send(socket, { type: "pair-result", ok: false, reason: "unknown device id" });
          return;
        }
        if (hasExceededAttempts(message.deviceId)) {
          send(socket, { type: "pair-result", ok: false, reason: "too many attempts" });
          return;
        }
        const valid = await verifyPin(message.pin, agent.pinHash);
        if (!valid) {
          recordFailedAttempt(message.deviceId);
          send(socket, { type: "pair-result", ok: false, reason: "incorrect pin" });
          return;
        }
        // Correct PIN alone doesn't open the session -- the agent operator
        // still has to accept. Overwrites any previous pending request for
        // this device (the newest request wins; the old one just times out
        // with no one listening, which is fine).
        setPendingController(message.deviceId, socket);
        clearPendingTimeout(message.deviceId);
        pendingTimeouts.set(
          message.deviceId,
          setTimeout(() => {
            const pendingWs = takePendingController(message.deviceId);
            pendingTimeouts.delete(message.deviceId);
            if (pendingWs) {
              send(pendingWs, { type: "pair-result", ok: false, reason: "no response from agent" });
            }
          }, PENDING_APPROVAL_TIMEOUT_MS),
        );
        send(agent.ws, {
          type: "connection-request",
          deviceId: message.deviceId,
          controllerId: message.controllerId,
        });
        send(socket, { type: "pairing-pending" });
        console.log(`connection request pending approval: ${message.deviceId}`);
        break;
      }

      case "connection-response": {
        const agent = getAgent(message.deviceId);
        if (!agent || agent.ws !== socket) break; // only the real agent may answer
        clearPendingTimeout(message.deviceId);
        const pendingWs = takePendingController(message.deviceId);
        if (!pendingWs) break; // already resolved (timed out, controller left)
        if (message.accept) {
          pairController(message.deviceId, pendingWs);
          send(pendingWs, { type: "pair-result", ok: true });
          send(agent.ws, { type: "pair-result", ok: true });
          console.log(`controller paired with agent: ${message.deviceId}`);
        } else {
          send(pendingWs, { type: "pair-result", ok: false, reason: "rejected by agent" });
          console.log(`connection request rejected: ${message.deviceId}`);
        }
        break;
      }

      // SDP/ICE messages just get relayed between whichever two sockets are
      // paired for this deviceId -- the server never inspects their contents.
      case "sdp-offer":
      case "sdp-answer":
      case "ice-candidate": {
        const target = resolveRelayTarget(message.deviceId, socket);
        if (target) send(target, message);
        break;
      }

      case "list-devices": {
        subscribeToDeviceList(socket);
        send(socket, { type: "device-list", devices: listDevices() });
        break;
      }

      case "remove-device": {
        if (removeDevice(message.deviceId)) {
          for (const controllerWs of getSubscribedControllers()) {
            send(controllerWs, { type: "device-removed", deviceId: message.deviceId });
          }
        }
        break;
      }

      case "ping":
        send(socket, { type: "pong" });
        break;

      case "register-result":
      case "pair-result":
      case "pong":
      case "device-list":
      case "device-status-changed":
      case "connection-request":
      case "pairing-pending":
      case "device-removed":
        // Server-to-client only; ignore if a client somehow sends one.
        break;
    }
  });

  socket.on("close", () => {
    const { offlineDeviceId, orphanedPendingController } = removeConnection(socket);
    if (offlineDeviceId) {
      clearPendingTimeout(offlineDeviceId);
      broadcastDeviceUpdate(offlineDeviceId);
    }
    if (orphanedPendingController) {
      send(orphanedPendingController, {
        type: "pair-result",
        ok: false,
        reason: "agent disconnected",
      });
    }
    console.log("client disconnected");
  });
});

console.log(`signaling server listening on ws://localhost:${port}`);
