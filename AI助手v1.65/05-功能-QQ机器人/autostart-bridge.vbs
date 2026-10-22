' AI 助手 · QQ 机器人桥接 开机自启（隐藏窗口；连不上会自动指数退避重试，直到工作台就绪）
Dim sh
Set sh = CreateObject("WScript.Shell")
sh.Run "cmd /c D:\long.app\app\tools\qqbot\start-bridge-hidden.cmd", 0, False
