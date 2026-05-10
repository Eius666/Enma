const validateRequest = (req) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return { ok: false, status: 503, body: { ok: false, description: 'Service not configured' } };
  }

  const header = req.headers?.authorization ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : header;
  if (provided === cronSecret) {
    return { ok: true };
  }

  return {
    ok: false,
    status: 401,
    body: { ok: false, description: 'Unauthorized' }
  };
};

module.exports = { validateRequest };
