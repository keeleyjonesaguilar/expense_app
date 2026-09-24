// Server-side half of the shared typed-confirmation modal (see
// views/partials/confirm_modal.ejs). Case-insensitive on purpose -- the
// point is to stop an accidental click, not to test spelling/shift-key
// precision.
function typedConfirmMatches(req, word) {
  return (req.body.confirm || '').trim().toLowerCase() === String(word).trim().toLowerCase();
}

module.exports = { typedConfirmMatches };
