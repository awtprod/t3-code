# Sprint plans

Open **Sprint plan** from the Command Center sidebar and choose a Space. The plan list shows only plans in that Space. Select a plan to view its current tasks, goals, progress, carryovers, upcoming weeks, and change history. Week and owner filters change which tasks are shown; unfinished tasks from past weeks remain open.

Use **Original** to inspect the first imported source. It is read-only and remains available after edits or later imports. **Current** shows the working plan. A direct task link in Current opens the task by its ID.

To import a plan, choose a JSON file and select **Preview source**. Preview shows the task count, source digest, date clarifications, and any conflicts with local edits. Applying the import checks the current plan version and preserves the exact applied source. For each conflicting field, choose **Keep current** or **Use incoming** before applying. If the incoming source removed a locally edited task, **Keep current** is unavailable; correct the source to retain that task. The server checks every choice together against the current conflicts, so a changed plan requires a fresh preview.

Select **Edit** on a Current task to change its note, day, or completion. Give a reason and save the exact field. You can reverse a completion by editing it again. If someone else changed the plan, refresh and review their change before retrying. Date clarifications are recorded separately from the imported wording, with a reviewed date and reason. The change history keeps prior values and reasons.
