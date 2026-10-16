using System.IO;
using System.Diagnostics;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;
using System.Windows;
using NotepadHub.Core;

namespace NotepadHub.Host;

public partial class App : Application
{
    private Mutex? _single;
    private NoteStore? _store;

    public static string Version => "4.0.0-preview.1";

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        DispatcherUnhandledException += (_, ex) => { HostLog.Write("unhandled: " + ex.Exception); MessageBox.Show("Произошла внутренняя ошибка. Данные не повреждены; подробности записаны в журнал.", "Notepad Hub", MessageBoxButton.OK, MessageBoxImage.Error); ex.Handled = true; };

        var paths = DataPaths.Resolve();
        var key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(paths.Root.ToLowerInvariant())))[..16];
        _single = new Mutex(true, "Local\\NotepadHub4." + key, out var first);
        if (!first)
        {
            ForwardToRunningInstance(key, e.Args);
            Shutdown();
            return;
        }

        // Notepad Hub 3.x writes the same folder: never run two generations on one profile at once.
        var isDefaultProfile = string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("NOTEPADHUB_DATA_ROOT"));
        if (isDefaultProfile && Process.GetProcessesByName("NotepadHub").Length > 0)
        {
            MessageBox.Show("Сейчас запущен Notepad Hub 3. Закройте его, чтобы две версии не записывали одни и те же заметки одновременно, и откройте Notepad Hub 4 снова.", "Notepad Hub 4", MessageBoxButton.OK, MessageBoxImage.Information);
            Shutdown();
            return;
        }

        try
        {
            _store = new NoteStore(paths);
            _store.Initialize();
        }
        catch (StoreLockedException)
        {
            MessageBox.Show("Эти данные уже открыты в другом окне Notepad Hub 4.", "Notepad Hub 4", MessageBoxButton.OK, MessageBoxImage.Information);
            Shutdown();
            return;
        }
        catch (Exception ex)
        {
            HostLog.Write("startup: " + ex);
            MessageBox.Show("Не удалось открыть хранилище заметок. Файлы не изменены.\n\n" + ex.Message, "Notepad Hub 4", MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown();
            return;
        }

        OpenFilesFromArguments(_store, e.Args);
        var window = new MainWindow(_store, paths);
        MainWindow = window;
        window.Show();
        StartPipeServer(key, window);
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _store?.Dispose();
        try { _single?.ReleaseMutex(); } catch { }
        _single?.Dispose();
        base.OnExit(e);
    }

    private static void OpenFilesFromArguments(NoteStore store, IEnumerable<string> args)
    {
        foreach (var a in args.Where(x => !string.IsNullOrWhiteSpace(x) && File.Exists(x)))
        {
            try { var n = store.OpenInPlace(a, store.Settings.ActiveProjectId); var s = store.Settings; s.SelectedNoteId = n.Id; store.SaveSettings(s); }
            catch (Exception ex) { HostLog.Write("open arg: " + ex.Message); }
        }
    }

    private static void ForwardToRunningInstance(string key, string[] args)
    {
        try
        {
            using var client = new NamedPipeClientStream(".", "NotepadHub4." + key, PipeDirection.Out, PipeOptions.CurrentUserOnly);
            client.Connect(2000);
            using var w = new StreamWriter(client, new UTF8Encoding(false));
            // the running window has another working folder: send full paths
            foreach (var a in args) w.WriteLine(File.Exists(a) ? Path.GetFullPath(a) : a);
            w.WriteLine("\u0001ACTIVATE");
        }
        catch (Exception ex) { HostLog.Write("forward: " + ex.Message); }
    }

    private void StartPipeServer(string key, MainWindow window)
    {
        _ = Task.Run(async () =>
        {
            while (true)
            {
                try
                {
                    using var server = new NamedPipeServerStream("NotepadHub4." + key, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                    await server.WaitForConnectionAsync();
                    using var r = new StreamReader(server, Encoding.UTF8);
                    var files = new List<string>();
                    using var timeout = new CancellationTokenSource(3000);   // a client that connects and stays silent must not block the channel
                    string? line;
                    while (files.Count < 50 && (line = await r.ReadLineAsync(timeout.Token)) != null) if (line != "\u0001ACTIVATE" && line.Length > 0) files.Add(line);
                    await Dispatcher.InvokeAsync(() => window.ActivateAndOpen(files));
                }
                catch (Exception ex) { HostLog.Write("pipe: " + ex.Message); await Task.Delay(500); }
            }
        });
    }
}

internal static class HostLog
{
    public static void Write(string message)
    {
        try
        {
            var dir = Path.Combine(DataPaths.Resolve().Root, "logs");
            Directory.CreateDirectory(dir);
            File.AppendAllText(Path.Combine(dir, "host-v4.log"), DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + message + Environment.NewLine, Encoding.UTF8);
        }
        catch { }
    }
}


