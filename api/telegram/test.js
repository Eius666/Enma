module.exports = async (req, res) => {
  res.status(200).json({ ok: true, message: 'Webhook endpoint is alive!', method: req.method });
};
