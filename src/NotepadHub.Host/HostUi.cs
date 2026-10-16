using System.IO;
using System.Windows;
using Microsoft.Win32;
using NotepadHub.Core.Backup;
using NotepadHub.Core.Bridge;

namespace NotepadHub.Host;

/// <summary>Native file dialogs. They run on the UI thread; the page only ever sees what the user picked.</summary>
internal sealed class HostUi : IHostUi
{
    private readonly MainWindow _owner;
    public HostUi(MainWindow owner) { _owner = owner; }

    /// <summary>Opens Explorer with the note's file selected. The path comes from the note store, never from the page.</summary>
    public void RevealFile(string path)
    {
        try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("explorer.exe", "/select,\"" + path + "\"") { UseShellExecute = true }); }
        catch (Exception ex) { HostLog.Write("reveal failed: " + ex.Message); }
    }

    public string? PickWindowsSnapshot() => _owner.Dispatcher.Invoke(() =>
    {
        var d = new OpenFileDialog { Title = "ZIP-снимок Windows Notepad (папка TabState)", Filter = "ZIP-архив|*.zip", CheckFileExists = true };
        return d.ShowDialog(_owner) == true ? d.FileName : null;
    });

    public IReadOnlyList<string> PickTextFiles() => _owner.Dispatcher.Invoke<IReadOnlyList<string>>(() =>
    {
        var d = new OpenFileDialog
        {
            Title = "Открыть текстовые файлы как заметки", Multiselect = true, CheckFileExists = true,
            Filter = "Текстовые файлы|*.txt;*.md;*.markdown;*.html;*.htm;*.json;*.xml;*.yaml;*.yml;*.log;*.csv;*.ps1;*.cmd;*.bat;*.js;*.ts;*.py;*.cs;*.css;*.sql;*.ini;*.toml|Все файлы|*.*",
        };
        return d.ShowDialog(_owner) == true ? d.FileNames : Array.Empty<string>();
    });

    public string? PickBackupSavePath(string suggestedName) => _owner.Dispatcher.Invoke(() =>
    {
        var d = new SaveFileDialog { Title = "Резервная копия Notepad Hub", Filter = "Резервная копия Notepad Hub|*.nhub", FileName = suggestedName, OverwritePrompt = true };
        return d.ShowDialog(_owner) == true ? d.FileName : null;
    });

    public string? PickBackupOpenPath() => _owner.Dispatcher.Invoke(() =>
    {
        var d = new OpenFileDialog { Title = "Восстановить из резервной копии", Filter = "Резервная копия Notepad Hub|*.nhub", CheckFileExists = true };
        return d.ShowDialog(_owner) == true ? d.FileName : null;
    });

    public bool ConfirmRestore(BackupInfo backup, int currentNotes) => _owner.Dispatcher.Invoke(() =>
        MessageBox.Show(_owner,
            $"Заменить текущие заметки ({currentNotes}) заметками из копии ({backup.NoteCount}, папок: {backup.ProjectCount}, создана {backup.CreatedUtc[..Math.Min(10, backup.CreatedUtc.Length)]})?\n\nПеред заменой программа сохранит точку возврата с текущим состоянием: её можно будет восстановить так же.",
            "Восстановление из копии", MessageBoxButton.YesNo, MessageBoxImage.Warning, MessageBoxResult.No) == MessageBoxResult.Yes);
}

