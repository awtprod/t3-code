# Observations

Open **Observations** from the sidebar, then choose an environment and Space. The list shows each measurement's collection method, value or missing-data reason, period, and collection time. Select an observation to inspect its source identity, metric definition, sample, denominator, freshness, completeness, and revision history. Older revisions can be loaded in pages. The page URL preserves the selected environment, Space, and observation so you can reopen a specific record.

After correcting a measurement, select **Propose a lesson from this correction** in its revision history. The proposal opens in Lessons with a link back to that exact revision. A proposed lesson waits for review before it can appear in approved-memory retrieval.

**Add manual** opens an editable example for a channel subscriber measurement. Replace its subject, source identity, times, metric, and data with your real values. A missing value needs a reason and is displayed as missing, never as zero. **Import JSON** accepts an array of observations marked `imported`; the batch must belong to the selected Space and meet the displayed size and count limits. The page validates entries before sending them.

To fix data, select an active observation, edit its data JSON, add a reason, and choose **Save correction**. The original source identity and earlier revisions remain available. **Retire observation** asks for a reason and confirmation; retired observations remain visible in history.

The page shows whether another collection method reports the same metric for the same subject and period. It does not claim that a measurement is eligible to change a plan: eligibility needs a separately configured, server-owned policy and an approval tied to the exact evidence revision.
