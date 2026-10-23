const TYPE_TO_ICON: Record<string, string> = {
	note: "📝",
	abstract: "📄",
	summary: "📄",
	tldr: "📄",
	info: "ℹ️",
	todo: "☑️",
	tip: "💡",
	hint: "💡",
	important: "💡",
	success: "✅",
	check: "✅",
	done: "✅",
	question: "❓",
	help: "❓",
	faq: "❓",
	warning: "⚠️",
	caution: "⚠️",
	attention: "⚠️",
	failure: "❌",
	fail: "❌",
	missing: "❌",
	danger: "⚡",
	error: "⚡",
	bug: "🐞",
	example: "📋",
	quote: "💬",
	cite: "💬",
};

const ICON_TO_TYPE: Record<string, string> = {
	"📝": "note",
	"📄": "abstract",
	"ℹ️": "info",
	"☑️": "todo",
	"💡": "tip",
	"✅": "success",
	"❓": "question",
	"⚠️": "warning",
	"❌": "failure",
	"⚡": "danger",
	"🐞": "bug",
	"📋": "example",
	"💬": "quote",
};

export const UNKNOWN_CALLOUT_ICON = "📌";

export function iconForCalloutType(type: string): string | null {
	return TYPE_TO_ICON[type.toLowerCase()] ?? null;
}

export function calloutTypeForIcon(icon: string): string | null {
	return ICON_TO_TYPE[icon] ?? null;
}
