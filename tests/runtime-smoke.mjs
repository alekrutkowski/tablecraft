import { WebR, ChannelType } from 'webr';
const webR = new WebR({ baseUrl: new URL('../node_modules/webr/dist/', import.meta.url).pathname, channelType: ChannelType.PostMessage, interactive: false });
try {
  await webR.init();
  console.log(await webR.evalRString('R.version.string'));
  console.log(await webR.evalRString('paste(rownames(installed.packages()), collapse = ", ")'));
} finally { await webR.close(); }
