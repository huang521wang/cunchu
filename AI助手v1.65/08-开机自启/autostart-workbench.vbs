' AI 助手 · 工作台服务 开机自启（隐藏窗口）
Dim sh
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "D:\long.app\app"
sh.Run """C:\Program Files\nodejs\New Folder\node.exe"" server\server.js", 0, False
