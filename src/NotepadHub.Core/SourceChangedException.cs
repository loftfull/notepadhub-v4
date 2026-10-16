namespace NotepadHub.Core;

/// <summary>The source file was modified outside the app since it was read.</summary>
public sealed class SourceChangedException : InvalidOperationException
{
    public SourceChangedException(string message) : base(message) { }
}
