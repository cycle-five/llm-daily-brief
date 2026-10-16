/** Recommended wording for the scheduled brief. Keep README.md's copy identical. */
export const BRIEF_PROMPT_SNIPPET = [
	"For the math section, call msc_class and stay inside the class it returns.",
	"It is the fixed rotation through all 63 MSC2020 top-level classes; do not compute the index yourself.",
	"Within that class, pick one specific named theorem, object, construction or result that genuinely belongs to it",
	"(prefer something less famous over the obvious headline result).",
	'Show the class under the section heading as the heading it returned, like "MSC 26 · Real functions".',
	"Before writing the math section, choose that topic on your own, without calling list_topics or",
	'check_topic first, then call claim_topic with category "math" and the topic\'s common name.',
	"Claiming blind is what makes the repeat counter meaningful.",
	'If the result is "repeat", choose a different topic and call',
	'again, up to 5 times. If the result is "possible_repeat", decide whether your topic is the',
	"same as any listed match: if it is, call skip_topic with repeat_of set to that match's",
	"entry_id and choose again; if not, call keep_topic. Include a short note with either call.",
	'Do the same with category "person" for the historical figure.',
].join(" ");
