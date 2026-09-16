/** Recommended wording for the scheduled brief. Keep README.md's copy identical. */
export const BRIEF_PROMPT_SNIPPET = [
	"Before writing the math section, choose a topic on your own, without calling list_topics or",
	'check_topic first, then call claim_topic with category "math" and the topic\'s common name.',
	"Claiming blind is what makes the repeat counter meaningful.",
	'If the result is "repeat", choose a different topic and call',
	'again, up to 5 times. If the result is "possible_repeat", decide whether your topic is the',
	"same as any listed match: if it is, call skip_topic with repeat_of set to that match's",
	"entry_id and choose again; if not, call keep_topic. Include a short note with either call.",
	'Do the same with category "person" for the historical figure.',
].join(" ");
