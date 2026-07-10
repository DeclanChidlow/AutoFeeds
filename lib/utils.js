"use strict";

const VERBOSE = process.env.VERBOSE_LOGGING === "true" || process.env.VERBOSE_LOGGING === "1";

function verboseLog(...args) {
	if (VERBOSE) console.log(...args);
}

module.exports = { VERBOSE, verboseLog };
