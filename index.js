var fs = require('fs');
var glob = require('glob');
var mkdirp = require('mkdirp');
var os = require('os');
var pathUtil = require('path');
var Promise = require('bluebird');
var ts = require('typescript');
var filenameToMid = (function () {
    if (pathUtil.sep === '/') {
        return function (filename) {
            return filename;
        };
    }
    else {
        var separatorExpression = new RegExp(pathUtil.sep.replace('\\', '\\\\'), 'g');
        return function (filename) {
            return filename.replace(separatorExpression, '/');
        };
    }
})();
function getError(diagnostics) {
    var message = 'Declaration generation failed';
    diagnostics.forEach(function (diagnostic) {
        var position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
        message +=
            ("\n" + diagnostic.file.fileName + "(" + (position.line + 1) + "," + (position.character + 1) + "): ") +
                ("error TS" + diagnostic.code + ": " + diagnostic.messageText);
    });
    var error = new Error(message);
    error.name = 'EmitterError';
    return error;
}
function getFilenames(baseDir, files) {
    return files.map(function (filename) {
        var resolvedFilename = pathUtil.resolve(filename);
        if (resolvedFilename.indexOf(baseDir) === 0) {
            return resolvedFilename;
        }
        return pathUtil.resolve(baseDir, filename);
    });
}
function processTree(sourceFile, replacer) {
    var code = '';
    var cursorPosition = 0;
    function skip(node) {
        cursorPosition = node.end;
    }
    function readThrough(node) {
        code += sourceFile.text.slice(cursorPosition, node.pos);
        cursorPosition = node.pos;
    }
    function visit(node) {
        readThrough(node);
        var replacement = replacer(node);
        if (replacement != null) {
            code += replacement;
            skip(node);
        }
        else {
            ts.forEachChild(node, visit);
        }
    }
    visit(sourceFile);
    code += sourceFile.text.slice(cursorPosition);
    return code;
}
function generate(options, sendMessage) {
    if (sendMessage === void 0) { sendMessage = function () { }; }
    var baseDir = pathUtil.resolve(options.baseDir);
    var eol = options.eol || os.EOL;
    var nonEmptyLineStart = new RegExp(eol + '(?!' + eol + '|$)', 'g');
    var indent = options.indent === undefined ? '\t' : options.indent;
    var target = options.target || 2 /* Latest */;
    var compilerOptions = {
        declaration: true,
        module: 1 /* CommonJS */,
        target: target
    };
    if (options.outDir) {
        compilerOptions.outDir = options.outDir;
    }
    var filenames = getFilenames(baseDir, options.files);
    var excludesMap = {};
    options.excludes = options.excludes || ['node_modules/**/*.d.ts'];
    options.excludes && options.excludes.forEach(function (filename) {
        glob.sync(filename).forEach(function (globFileName) {
            excludesMap[filenameToMid(pathUtil.resolve(baseDir, globFileName))] = true;
        });
    });
    mkdirp.sync(pathUtil.dirname(options.out));
    /* node.js typings are missing the optional mode in createWriteStream options and therefore
     * in TS 1.6 the strict object literal checking is throwing, therefore a hammer to the nut */
    var output = fs.createWriteStream(options.out, { mode: parseInt('644', 8) });
    var host = ts.createCompilerHost(compilerOptions);
    var program = ts.createProgram(filenames, compilerOptions, host);
    function writeFile(filename, data, writeByteOrderMark) {
        // Compiler is emitting the non-declaration file, which we do not care about
        if (filename.slice(-5) !== '.d.ts') {
            return;
        }
        writeDeclaration(ts.createSourceFile(filename, data, target, true));
    }
    return new Promise(function (resolve, reject) {
        output.on('close', function () { resolve(undefined); });
        output.on('error', reject);
        if (options.externs) {
            options.externs.forEach(function (path) {
                sendMessage("Writing external dependency " + path);
                output.write(("/// <reference path=\"" + path + "\" />") + eol);
            });
        }
        program.getSourceFiles().some(function (sourceFile) {
            // Source file is a default library, or other dependency from another project, that should not be included in
            // our bundled output
            if (pathUtil.normalize(sourceFile.fileName).indexOf(baseDir) !== 0) {
                return;
            }
            if (excludesMap[filenameToMid(pathUtil.normalize(sourceFile.fileName))]) {
                return;
            }
            sendMessage("Processing " + sourceFile.fileName);
            // Source file is already a declaration file so should does not need to be pre-processed by the emitter
            if (sourceFile.fileName.slice(-5) === '.d.ts') {
                writeDeclaration(sourceFile);
                return;
            }
            var emitOutput = program.emit(sourceFile, writeFile);
            if (emitOutput.emitSkipped || emitOutput.diagnostics.length > 0) {
                reject(getError(emitOutput.diagnostics
                    .concat(program.getSemanticDiagnostics(sourceFile))
                    .concat(program.getSyntacticDiagnostics(sourceFile))
                    .concat(program.getDeclarationDiagnostics(sourceFile))));
                return true;
            }
        });
        if (options.main) {
            output.write(("declare module '" + options.name + "' {") + eol + indent);
            output.write(("export * from '" + options.main + "';") + eol);
            output.write('}' + eol);
            sendMessage("Aliased main module " + options.name + " to " + options.main);
        }
        output.end();
    });
    function writeDeclaration(declarationFile) {
        var filename = declarationFile.fileName;
        var sourceModuleId = options.name + filenameToMid(filename.slice(baseDir.length, -5));
        /* For some reason, SourceFile.externalModuleIndicator is missing from 1.6-beta, so having
         * to use a sledgehammer on the nut */
        if (declarationFile.externalModuleIndicator) {
            output.write('declare module \'' + sourceModuleId + '\' {' + eol + indent);
            var content = processTree(declarationFile, function (node) {
                if (node.kind === 230 /* ExternalModuleReference */) {
                    var expression = node.expression;
                    if (expression.text.charAt(0) === '.') {
                        return ' require(\'' + filenameToMid(pathUtil.join(pathUtil.dirname(sourceModuleId), expression.text)) + '\')';
                    }
                }
                else if (node.kind === 120 /* DeclareKeyword */) {
                    return '';
                }
                else if (node.kind === 9 /* StringLiteral */ &&
                    (node.parent.kind === 226 /* ExportDeclaration */ || node.parent.kind === 220 /* ImportDeclaration */)) {
                    var text = node.text;
                    if (text.charAt(0) === '.') {
                        return " '" + filenameToMid(pathUtil.join(pathUtil.dirname(sourceModuleId), text)) + "'";
                    }
                }
            });
            output.write(content.replace(nonEmptyLineStart, '$&' + indent));
            output.write(eol + '}' + eol);
        }
        else {
            output.write(declarationFile.text);
        }
    }
}
exports.generate = generate;
