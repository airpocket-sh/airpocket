"use strict";
// Text that looks like a key or a token. The file viewer never shows a file
// whose text matches; a prompt or reply snippet that matches is dropped
// whole, by the hook and again by the service, so it is never stored or
// shown on the phone.
const SECRET_CONTENT = /-----BEGIN [A-Z ]*PRIVATE KEY-----|"private_key"\s*:|\bAKIA[0-9A-Z]{16}\b|\bsk-(ant-)?[A-Za-z0-9_-]{24,}|\bgh[pousr]_[A-Za-z0-9]{30,}|\bxox[abprs]-[A-Za-z0-9-]{20,}/;

module.exports = { SECRET_CONTENT };
