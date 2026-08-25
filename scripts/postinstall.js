const globalInstall = process.env.npm_config_global === "true";
const launchCommand = globalInstall ? "audiotranslate" : "npm start";
const providersCommand = globalInstall ? "audiotranslate providers" : "npm run providers";

process.stdout.write(`
AudioTranslate đã được cài đặt.
Tiếp theo: ${launchCommand}
Xem provider và chi phí: ${providersCommand}

`);
