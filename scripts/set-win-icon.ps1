param(
  [Parameter(Mandatory = $true)]
  [string]$ExePath,
  [Parameter(Mandatory = $true)]
  [string]$IconPath
)

$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;

public static class WorkHelperResourceEditor
{
    private const uint LOAD_LIBRARY_AS_DATAFILE = 0x00000002;
    private static readonly IntPtr RT_ICON = new IntPtr(3);
    private static readonly IntPtr RT_GROUP_ICON = new IntPtr(14);

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate bool EnumResNameProc(IntPtr module, IntPtr type, IntPtr name, IntPtr param);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr LoadLibraryEx(string fileName, IntPtr file, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FreeLibrary(IntPtr module);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool EnumResourceNames(IntPtr module, IntPtr type, EnumResNameProc callback, IntPtr param);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr BeginUpdateResource(string fileName, bool deleteExistingResources);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool UpdateResource(IntPtr update, IntPtr type, IntPtr name, ushort language, byte[] data, uint size);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "UpdateResourceW", SetLastError = true)]
    private static extern bool UpdateResourceString(IntPtr update, IntPtr type, string name, ushort language, byte[] data, uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool EndUpdateResource(IntPtr update, bool discard);

    private sealed class ResourceName
    {
        public ushort Id;
        public string Text;
        public bool IsInteger;
    }

    private sealed class IconEntry
    {
        public byte Width;
        public byte Height;
        public byte ColorCount;
        public byte Reserved;
        public ushort Planes;
        public ushort BitCount;
        public uint Size;
        public byte[] Data;
        public ushort ResourceId;
    }

    public static int SetIcon(string exePath, string iconPath)
    {
        List<ResourceName> groupNames = ReadGroupNames(exePath);
        if (groupNames.Count == 0) groupNames.Add(new ResourceName { Id = 1, IsInteger = true });
        List<IconEntry> entries = ReadIcon(iconPath);
        for (int index = 0; index < entries.Count; index++) entries[index].ResourceId = (ushort)(5001 + index);
        byte[] groupData = BuildGroupData(entries);

        IntPtr update = BeginUpdateResource(exePath, false);
        if (update == IntPtr.Zero) ThrowLastError("BeginUpdateResource");
        bool completed = false;
        try
        {
            foreach (IconEntry entry in entries)
            {
                if (!UpdateResource(update, RT_ICON, new IntPtr(entry.ResourceId), 0, entry.Data, (uint)entry.Data.Length))
                    ThrowLastError("UpdateResource RT_ICON");
            }
            foreach (ResourceName name in groupNames)
            {
                bool written = name.IsInteger
                    ? UpdateResource(update, RT_GROUP_ICON, new IntPtr(name.Id), 0, groupData, (uint)groupData.Length)
                    : UpdateResourceString(update, RT_GROUP_ICON, name.Text, 0, groupData, (uint)groupData.Length);
                if (!written) ThrowLastError("UpdateResource RT_GROUP_ICON");
            }
            if (!EndUpdateResource(update, false)) ThrowLastError("EndUpdateResource");
            completed = true;
            return groupNames.Count;
        }
        finally
        {
            if (!completed) EndUpdateResource(update, true);
        }
    }

    private static List<ResourceName> ReadGroupNames(string exePath)
    {
        var names = new List<ResourceName>();
        IntPtr module = LoadLibraryEx(exePath, IntPtr.Zero, LOAD_LIBRARY_AS_DATAFILE);
        if (module == IntPtr.Zero) ThrowLastError("LoadLibraryEx");
        try
        {
            EnumResNameProc callback = delegate(IntPtr handle, IntPtr type, IntPtr name, IntPtr param)
            {
                long raw = name.ToInt64();
                if ((raw >> 16) == 0) names.Add(new ResourceName { Id = (ushort)raw, IsInteger = true });
                else names.Add(new ResourceName { Text = Marshal.PtrToStringUni(name), IsInteger = false });
                return true;
            };
            EnumResourceNames(module, RT_GROUP_ICON, callback, IntPtr.Zero);
            GC.KeepAlive(callback);
        }
        finally
        {
            FreeLibrary(module);
        }
        return names;
    }

    private static List<IconEntry> ReadIcon(string iconPath)
    {
        using (var stream = File.OpenRead(iconPath))
        using (var reader = new BinaryReader(stream))
        {
            if (reader.ReadUInt16() != 0 || reader.ReadUInt16() != 1) throw new InvalidDataException("Invalid ICO header.");
            ushort count = reader.ReadUInt16();
            var entries = new List<IconEntry>(count);
            var offsets = new uint[count];
            for (int index = 0; index < count; index++)
            {
                var entry = new IconEntry {
                    Width = reader.ReadByte(), Height = reader.ReadByte(), ColorCount = reader.ReadByte(), Reserved = reader.ReadByte(),
                    Planes = reader.ReadUInt16(), BitCount = reader.ReadUInt16(), Size = reader.ReadUInt32()
                };
                offsets[index] = reader.ReadUInt32();
                entries.Add(entry);
            }
            for (int index = 0; index < entries.Count; index++)
            {
                stream.Position = offsets[index];
                entries[index].Data = reader.ReadBytes(checked((int)entries[index].Size));
                if (entries[index].Data.Length != entries[index].Size) throw new EndOfStreamException("ICO image data is truncated.");
            }
            return entries;
        }
    }

    private static byte[] BuildGroupData(List<IconEntry> entries)
    {
        using (var stream = new MemoryStream())
        using (var writer = new BinaryWriter(stream))
        {
            writer.Write((ushort)0);
            writer.Write((ushort)1);
            writer.Write((ushort)entries.Count);
            foreach (IconEntry entry in entries)
            {
                writer.Write(entry.Width); writer.Write(entry.Height); writer.Write(entry.ColorCount); writer.Write(entry.Reserved);
                writer.Write(entry.Planes); writer.Write(entry.BitCount); writer.Write(entry.Size); writer.Write(entry.ResourceId);
            }
            return stream.ToArray();
        }
    }

    private static void ThrowLastError(string operation)
    {
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), operation);
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp
$resolvedExe = (Resolve-Path -LiteralPath $ExePath).Path
$resolvedIcon = (Resolve-Path -LiteralPath $IconPath).Path
$groupCount = [WorkHelperResourceEditor]::SetIcon($resolvedExe, $resolvedIcon)
Write-Output "ICON_GROUPS_UPDATED=$groupCount"
