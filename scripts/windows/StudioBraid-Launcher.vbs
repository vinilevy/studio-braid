Option Explicit

Dim WshShell, fso, strScriptDir, strProjectDir, strCheckCmd, intRet, strStartCmd

Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Caminho do script e raiz do projeto (dois níveis acima de scripts\windows)
strScriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
strProjectDir = fso.GetParentFolderName(fso.GetParentFolderName(strScriptDir))

' Verifica se o servidor já está escutando na porta 3847
strCheckCmd = "cmd.exe /c netstat -ano | findstr :3847 | findstr LISTENING"
intRet = WshShell.Run(strCheckCmd, 0, True)

If intRet <> 0 Then
    ' Inicia o servidor em segundo plano totalmente silencioso (janela 0 oculta)
    strStartCmd = "cmd.exe /c cd /d """ & strProjectDir & """ && node packages/server/dist/index.js"
    WshShell.Run strStartCmd, 0, False
    ' Aguarda 2 segundos para o Fastify inicializar o bind
    WScript.Sleep 2000
End If

' Abre a interface do Studio Braid no navegador padrão
WshShell.Run "http://127.0.0.1:3847"
