const { getConfig, loadEnvFile } = require("./config");
const { RealtimeGateway } = require("./gateway");

async function run(argv = []) {
  loadEnvFile();
  const config = getConfig(argv);
  const gateway = new RealtimeGateway({ ...config, headless: true });
  let stdoutBlocked = false;
  let stopping = false;

  process.stdout.on("drain", () => {
    stdoutBlocked = false;
  });
  process.stdout.on("error", (error) => {
    if (error.code === "EPIPE") {
      stopping = true;
      gateway.close().catch(() => {});
      return;
    }
    throw error;
  });

  gateway.on("status", (status) => {
    process.stderr.write(`[${status.level}] ${status.message}\n`);
  });
  gateway.on("caption", (caption) => {
    const text = caption.translation || caption.transcript;
    if (!text) return;
    if (stdoutBlocked && !caption.isFinal) return;
    let accepted;
    if (process.stdout.isTTY && !caption.isFinal) {
      accepted = process.stdout.write(`\r\x1b[2K${text}`);
    } else if (process.stdout.isTTY) {
      accepted = process.stdout.write(`\r\x1b[2K${text}\n`);
    } else {
      accepted = process.stdout.write(`${JSON.stringify(caption)}\n`);
    }
    if (!accepted) stdoutBlocked = true;
  });
  gateway.on("language", (detection) => {
    process.stderr.write(
      `[language] ${detection.language} (${detection.confidence || "Unknown"}, ${
        detection.detectionLatencyMs
      } ms)\n`,
    );
  });
  gateway.on("error", (error) => {
    process.stderr.write(`[error] ${error.message}\n`);
  });

  const address = await gateway.start();
  process.stderr.write(`AudioTranslate headless is ready at ws://${address.host}:${address.port}\n`);

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await gateway.close();
    process.exitCode = 0;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

module.exports = { run };
