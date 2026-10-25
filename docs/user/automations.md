# Automations

Automations shows every recurring task an environment runs for you, and whether it is healthy, in one list: scheduled tasks, which you create under **Settings → Scheduled tasks** or an agent creates for you, and automations committed in the environment's private configuration.

Tasks that need you come first. A task whose last run failed is at the top, then running tasks, then healthy ones; paused tasks sit at the bottom. The **Automations** shortcut in the sidebar shows how many enabled tasks are currently failing, so a broken task is visible without a notification.

Select a scheduled task to see its schedule, model, last and next run, the error from a failed run, and the prompt it runs. From there you can run it now, pause or resume it, open its thread, or edit it in Settings. Select a committed automation to view or edit its definition.

The page follows the environment chosen under **Runs on** in its header. Scheduled tasks update live as the scheduler works; committed automations refresh as the environment reports changes. If the private configuration is missing or invalid, scheduled tasks are still listed.
