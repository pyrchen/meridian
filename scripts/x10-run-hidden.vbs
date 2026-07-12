' Тихий запуск X10-исполнителя из планировщика (без мигающего окна консоли).
' Задача: schtasks /TN MeridianX10 — каждые 10 минут. Путь к node абсолютный:
' PATH в контексте планировщика не гарантирован.
CreateObject("Wscript.Shell").Run """C:\Program Files\nodejs\node.exe"" ""D:\My Projects\meridian\scripts\x10-executor.mjs""", 0, False
