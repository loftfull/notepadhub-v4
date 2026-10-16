using System.Globalization;
using System.Text.Json.Serialization;

namespace NotepadHub.Core;

// Property names and types mirror Notepad Hub 3.0.x exactly (PascalCase JSON), so 3.0.5 can still read what v4 writes.

public sealed class ProjectModel
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Name { get; set; } = "Проект";
    public int Order { get; set; }
    public bool IsSystem { get; set; }
    public bool ShowInTabs { get; set; } = true;
    /// <summary>Id of the project this one is nested in; empty for a top-level project. 3.0.x ignores the property.</summary>
    public string ParentId { get; set; } = "";
}

public sealed class NoteMeta
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Title { get; set; } = "Новая заметка";
    public string ProjectId { get; set; } = "";
    public string SourcePath { get; set; } = "";
    public string SourceType { get; set; } = "local";
    public string ContentType { get; set; } = "text";
    public string Tags { get; set; } = "";
    public string CreatedUtc { get; set; } = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture);
    public string UpdatedUtc { get; set; } = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture);
    public string LastOpenedUtc { get; set; } = "";
    public string SourceLastWriteUtc { get; set; } = "";
    public string LegacySourceGuid { get; set; } = "";
    public bool IsPinned { get; set; }
    public bool IsArchived { get; set; }
    public bool IsDeleted { get; set; }
    public bool ExternalOnly { get; set; }

    public NoteMeta Clone() => (NoteMeta)MemberwiseClone();
}

/// <summary>v4 UI settings. Stored in their own file so the 3.0.x window geometry in settings.json is left alone.</summary>
public sealed class AppSettingsV4
{
    public int SchemaVersion { get; set; } = 1;
    public string ActiveProjectId { get; set; } = "inbox";
    public string SelectedNoteId { get; set; } = "";
    public string View { get; set; } = "project";
    public string Theme { get; set; } = "system";
    public bool SidebarVisible { get; set; } = true;
    public double WindowWidth { get; set; } = 1360;
    public double WindowHeight { get; set; } = 820;
    public double WindowLeft { get; set; } = double.NaN;
    public double WindowTop { get; set; } = double.NaN;
    public bool WindowMaximized { get; set; }
    public string[] OpenNoteIds { get; set; } = Array.Empty<string>();
    /// <summary>Notes opened from a file that are saved back into that file as you type (own file, so 3.0.x metadata stays untouched).</summary>
    public string[] WriteThroughIds { get; set; } = Array.Empty<string>();
}

/// <summary>A note as the UI needs it: metadata, plain text mirror, and (only if still valid) the BlockNote blocks.</summary>
public sealed class NoteDocument
{
    public NoteMeta Meta { get; set; } = new();
    public string Content { get; set; } = "";
    /// <summary>Raw JSON array of BlockNote blocks, or null when absent/stale (text changed outside v4 → UI rebuilds from Content).</summary>
    public string? BlocksJson { get; set; }
    public bool ExternalOnly { get; set; }
}

public sealed class HistoryEntry
{
    public string Name { get; set; } = "";
    public string TimestampLocal { get; set; } = "";
    public long Bytes { get; set; }
    public string Preview { get; set; } = "";
}

public sealed class ImportResult
{
    public int Created { get; set; }
    public int Updated { get; set; }
    public int Skipped { get; set; }
    public int EmptyWithExternalFile { get; set; }
    public List<string> Warnings { get; } = new();
}

public sealed class StoreLockedException : IOException
{
    public StoreLockedException(string message) : base(message) { }
}

