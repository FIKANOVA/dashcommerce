---
"@dashcommerce/core": patch
---

Keep pickup text between `<` and `>`. Saving a pickup method removed anything that looked like a tag, so "Gate <B>" became "Gate " and "<5 min walk> from the stage" lost its first words. The text is now kept as typed; control characters are still dropped and the length limits still apply. Every place that shows the text (checkout, thank-you page, receipt email, admin) already escapes it.
