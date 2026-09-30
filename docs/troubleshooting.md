# Troubleshooting

### The panel says that no media library is configured

Click `设置素材库位置` and choose the folder that contains the old relative
path. If the folder itself was renamed, add the old directory name under
`设置与记录`. The alias is a single directory name, not a full path.

### The panel finds several candidates

The plugin keeps the clip offline. Remove the duplicate or set a more specific
library root, then run `检查当前工程` again. It never chooses by filename alone
or by timestamp.

### Automatic checking stopped

Read the status and report. Typical causes are a changed active project, a file
changing while it was being checked, an incomplete project inventory, or a host
refresh failure. Inspect the journal in the displayed plugin data directory. If a
prepared transaction remains, check the project in Premiere first and then use
`已核对上次补链` to allow another scan.

### The offline Python tool refuses to run

The public checkout intentionally has no real machine configuration. Pass
`--media-root` or `--config` explicitly. The root must be the actual post-
production package, not a parent drive that happens to contain similarly named
files.

### Premiere opens a locate dialog before the panel runs

Use `打开工程并补链` inside the panel. The UXP API can suppress the locate dialog
when the plugin itself opens the project; it cannot promise to intercept every
ordinary double-click before Premiere has loaded the panel.
