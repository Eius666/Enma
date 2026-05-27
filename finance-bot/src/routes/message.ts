import { Router } from 'express';
import { handleMessage } from '../bot/handler';
import { getConfig } from '../utils/config';

const router = Router();

router.post('/message', async (req, res) => {
  const { userId, text } = req.body as { userId?: string; text?: string };

  if (!userId || !text) {
    return res.status(400).json({ reply: 'userId и text обязательны.' });
  }

  const config = getConfig();
  const response = await handleMessage(userId, text, config.autoConfirm);
  return res.json(response);
});

export default router;
