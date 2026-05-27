import express from 'express';
import messageRouter from './routes/message';
import { getConfig } from './utils/config';
import { logInfo } from './utils/logger';

const app = express();
const config = getConfig();

app.use(express.json());
app.use(messageRouter);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.listen(config.port, () => {
  logInfo(`Finance bot listening on port ${config.port}`);
  console.log(`Finance bot listening on port ${config.port}`);
});
