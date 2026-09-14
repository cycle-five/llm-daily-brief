/** Recommended wording for the scheduled brief. Keep README.md's copy identical. */
export const BRIEF_PROMPT_SNIPPET = [
	'Before writing the math section, choose a topic and call claim_topic with category "math"',
	'and the topic\'s common name. If the result is "repeat", choose a different topic and call',
	'again, up to 5 times. If the result is "claimed" but lists possible_matches you judge to be',
	"the same topic, call forget_topic on the new entry and choose again. Do the same with",
	'category "person" for the historical figure.',
].join(" ");
