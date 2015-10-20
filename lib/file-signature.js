var esprima = require('esprima'),
    escodegen = require('escodegen'),
    traverse = require('ast-traverse'),
    astUtils = require('esprima-ast-utils'),
    md5 = require('md5');

function formatLoc(loc) {
    return [loc.line, loc.column];
}

function calculateFunctionNodeHash(node) {
    var clonedNode = astUtils.clone(node);
    //calculate body hash
    traverse(clonedNode, {
        pre: function (node/*, parent, prop, idx*/) {
            if (node === clonedNode) {
            	return;
            }
            if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression") {
                node.body = { type: "BlockStatement", body: [] };
                node.params = [];
                node.id = { name: '_' };
            }
        }
    });
    
    var generated = escodegen.generate(clonedNode);
    var hash = md5(generated);
    return hash;
}

function generateFileSignature(bytes) {
    var result = {
        module: { hash: "" },
        methods: []
    };
    
    var ast;
    
    try {
        //1. Parse the file
        ast = esprima.parse(bytes, {
            loc: true,
            range: true,
            comment: false //No need for those
        });

    } catch (parseException) {
        //TODO: Test
        return { error: "Parse error (1)" };
    }
    
    try {
        
        // print AST node types, pre-order (node first, then its children) 
        traverse(ast, {
            pre: function (node/*, parent, prop, idx*/) {
                if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression") {
                    var hash = calculateFunctionNodeHash(node);
                    
                    var name = node.id && node.id.name;
                    var start = formatLoc(node.loc.start);
                    //var end = formatLoc(node.loc.end);
                    
                    result.methods.push({
                        name: name,
                        start: start,
                        //end: end,
                        hash: hash
                    });
                }
            }
        });
    }
    catch (traverseException1) {
        return { error: 'Parse error(2)' };
    }
    
    try {
        var bodyHash = calculateFunctionNodeHash(ast);        
        result.module.hash = bodyHash;
    } catch (traverseException2) {
        return { error: "Parse error (3)" };
    }
    
    return result;
}

module.exports = {
    generateFileSignature: generateFileSignature, 
    calculateFunctionNodeHash: calculateFunctionNodeHash
};