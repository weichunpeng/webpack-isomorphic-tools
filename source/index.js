import path   from 'path'
import fs     from 'fs'

import require_hacker from 'require-hacker'
import UglifyJS       from 'uglify-js'

import Log     from './tools/log'
import request from './tools/synchronous http'

import { exists, clone, convert_from_camel_case, starts_with, ends_with, alias_properties_with_camel_case } from './helpers'
import { default_webpack_assets, normalize_options, alias_hook, normalize_asset_path, uniform_path } from './common'

// using ES6 template strings
// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/template_strings
export default class webpack_isomorphic_tools
{
	// require() hooks for assets
	hooks = []

	// used to keep track of cached assets and flush their caches on .refresh() call
	cached_assets = []

	constructor(options)
	{
		// take the passed in options
		this.options = convert_from_camel_case(clone(options))

		// add missing fields, etc
		normalize_options(this.options)

		// set development mode flag
		this.options.development = process.env.NODE_ENV !== 'production'

		// set require-hacker debug mode if run in debug mode
		if (this.options.debug)
		{
			require_hacker.log.options.debug = true
		}

		// logging
		this.log = new Log('webpack-isomorphic-tools', { debug: this.options.debug })

		this.log.debug(`instantiated webpack-isomorphic-tools v${require('../package.json').version} with options`, this.options)
	}

	// (deprecated)
	// sets development mode flag to whatever was passed (or true if nothing was passed)
	// (development mode allows asset hot reloading when used with webpack-dev-server)
	development()
	{
		// display deprecation notice
		this.log.error('`.development()` method is now deprecated ' +
			'(for server-side instance only, not for webpack plugin instance) ' +
			'and has no effect. Set up a proper `process.env.NODE_ENV` variable instead: ' +
			'it should be "production" for production, otherwise it assumes development. ' + 
			'The currently used mode is: ' + (this.options.development ? 'development' : 'production') + '. ' +
			'`process.env.NODE_ENV is: ' + process.env.NODE_ENV)

		// allows method chaining
		return this
	}

	// returns a mapping to read file paths for all the user specified asset types
	// along with a couple of predefined ones: javascripts and styles
	assets()
	{
		// when in development mode
		if (this.options.development)
		{
			// webpack and node.js start in parallel
			// so webpack-assets.json might not exist on the very first run
			// if a developer chose not to use the .server() method with a callback
			// (or if a developer chose not to wait for a Promise returned by the .server() method)

			// either go over a network
			if (this.options.port)
			{
				try
				{
					return request(this.options.port)
				}
				catch (error)
				{
					this.log.error(`Couldn't contact webpack-isomorphic-tools plugin over HTTP. Using an empty stub for webpack assets map.`)
					this.log.error(error)
					return default_webpack_assets()
				}
			}
			// or read it from disk
			else
			{
				if (!fs.existsSync(this.webpack_assets_path))
				{
					this.log.error(`"${this.webpack_assets_path}" not found. Most likely it hasn't yet been generated by Webpack. The most probable cause of this error is that you placed your server code outside of the callback in "webpack_isomorphic_tools.server(path, callback)" (or outside of the ".then()" call if you are using promises API). Using an empty stub instead.`)
					return default_webpack_assets()
				}
			}
		}

		// sanity check
		if (!this.webpack_assets_path)
		{
			throw new Error(`You seem to have forgotten to call the .server() method`)
		}

		return require(this.webpack_assets_path)
	}

	// clear the require.cache (only used in developer mode with webpack-dev-server)
	refresh()
	{
		// ensure this is development mode
		if (!this.options.development)
		{
			throw new Error('.refresh() called in production mode. It shouldn\'t be called in production mode because that would degrade website performance by discarding caches.')
		}

		this.log.debug('flushing require() caches')

		// uncache webpack-assets.json file
		// this.log.debug(' flushing require() cache for webpack assets json file')
		// this.log.debug(` (was cached: ${typeof(require.cache[this.webpack_assets_path]) !== 'undefined'})`)
		delete require.cache[this.webpack_assets_path]

		// uncache cached assets
		for (let path of this.cached_assets)
		{
			this.log.debug(` flushing require() cache for ${path}`)
			delete require.cache[path]
		}

		// no assets are cached now
		this.cached_assets = []
	}

	// Makes `webpack-isomorphic-tools` aware of Webpack aliasing feature.
	// https://webpack.github.io/docs/resolving.html#aliasing
	// The `aliases` parameter corresponds to `resolve.alias`
	// in your Webpack configuration.
	// If this method is used it must be called before the `.server()` method.
	enable_aliasing()
	{
		// mount require() hook
		this.alias_hook = require_hacker.resolver((path, module) =>
		{
			// returns aliased global filesystem path
			return alias_hook(path, module, this.options.project_path, this.options.alias, this.log)
		})

		// allows method chaining
		return this
	}

	// Initializes server-side instance of `webpack-isomorphic-tools`
	// with the base path for your project, then calls `.register()`,
	// and after that calls .wait_for_assets(callback).
	//
	// The `project_path` parameter must be identical
	// to the `context` parameter of your Webpack configuration
	// and is needed to locate `webpack-assets.json`
	//  which is output by Webpack process.
	//
	// sets up "project_path" option
	// (this option is required on the server to locate webpack-assets.json)
	server(project_path, callback)
	{
		// project base path, required to locate webpack-assets.json
		this.options.project_path = project_path

		// resolve webpack-assets.json file path
		this.webpack_assets_path = path.resolve(this.options.project_path, this.options.webpack_assets_file_path)

		// register require() hooks
		this.register()

		// if Webpack aliases are supplied, enable aliasing
		if (this.options.alias)
		{
			this.enable_aliasing()
		}

		// if Webpack `modulesDirectories` are supplied, enable them
		if (this.options.modules_directories)
		{
			this.inject_modules_directories(this.options.modules_directories)
		}

		// inject helpers like require.context() and require.ensure()
		if (this.options.patch_require)
		{
			this.log.debug('Patching Node.js require() function')
			this.patch_require()
		}

		// when ready:

		// if callback is given, call it back
		if (callback)
		{
			// call back when ready
			return this.wait_for_assets(callback)
		}
		// otherwise resolve a Promise
		else
		{
			// no callback given, return a Promise
			return new Promise((resolve, reject) => this.wait_for_assets(resolve))
		}
	}

	// Registers Node.js require() hooks for the assets
	//
	// This is what makes the `requre()` magic work on server.
	// These `require()` hooks must be set before you `require()`
	// any of your assets
	// (e.g. before you `require()` any React components
	// `require()`ing your assets).
	//
	// read this article if you don't know what a "require hook" is
	// http://bahmutov.calepin.co/hooking-into-node-loader-for-fun-and-profit.html
	register()
	{
		this.log.debug('registering require() hooks for assets')

		// // a helper array for extension matching
		// const extensions = []
		//
		// // for each user specified asset type,
		// // for each file extension,
		// // create an entry in the extension matching array
		// for (let asset_type of Object.keys(this.options.assets))
		// {
		// 	const description = this.options.assets[asset_type]
		//
		// 	for (let extension of description.extensions)
		// 	{
		// 		extensions.push([`.${extension}`, description])
		// 	}
		// }
		//
		// // registers a global require() hook which runs
		// // before the default Node.js require() logic
		// this.asset_hook = require_hacker.global_hook('webpack-asset', (path, module) =>
		// {
		// 	// for each asset file extension
		// 	for (let extension of extensions)
		// 	{
		// 		// if the require()d path has this file extension
		// 		if (ends_with(path, extension[0]))
		// 		{
		// 			// then require() it using webpack-assets.json
		// 			return this.require(require_hacker.resolve(path, module), extension[1])
		// 		}
		// 	}
		// })

		// for each user specified asset type,
		// register a require() hook for each file extension of this asset type
		for (let asset_type of Object.keys(this.options.assets))
		{
			const description = this.options.assets[asset_type]

			for (let extension of description.extensions)
			{
				this.register_extension(extension, description)
			}
		}

		// intercepts loader-powered require() paths
		this.loaders_hook = require_hacker.global_hook('webpack-loaders', (required_path, module) =>
		{
			// filter out non-loader paths
			// (ignore filesystem paths (both Linux and Windows)
			//  and non-loader paths)
			if (starts_with(required_path, '/')
				|| starts_with(required_path, './')
				|| starts_with(required_path, '../')
				|| required_path.indexOf(':') > 0
				|| required_path.indexOf('!') < 0)
			{
				return
			}

			let parts = required_path.split('!')
			const local_asset_path = parts.pop()

			// extra measures taken here to not
			// confuse some legit require()d path
			// with a seemingly loader-powered one
			if (!starts_with(local_asset_path, './')
				&& !starts_with(local_asset_path, '../'))
			{
				return
			}

			parts = parts.map(loader =>
			{
				let loader_parts = loader.split('?')

				if (!ends_with(loader_parts[0], '-loader'))
				{
					loader_parts[0] += '-loader'
				}

				return `./~/${loader_parts.join('?')}`
			})

			const global_asset_path = require_hacker.resolve(local_asset_path, module)

			const path = parts.join('!') + '!' + this.normalize_asset_path(global_asset_path)

			const asset = this.asset_source(path)

			if (asset === undefined)
			{
				return
			}

			return this.require_asset(asset, { require_cache_path: required_path + '.webpack-loaders' })
		})

		// allows method chaining
		return this
	}

	// registers a require hook for a particular file extension
	register_extension(extension, description)
	{
		this.log.debug(` registering a require() hook for *.${extension}`)

		// place the require() hook for this extension
		if (extension === 'json')
		{
			this.hooks.push(require_hacker.hook(extension, path =>
			{
				// special case for require('webpack-assets.json') and 'json' asset extension
				if (path === this.webpack_assets_path)
				{
					return
				}

				return this.require(path, description)
			}))
		}
		else
		{
			this.hooks.push(require_hacker.hook(extension, path => this.require(path, description)))
		}
	}

	// injects Webpack's `modulesDirectories` into Node.js module resolver
	inject_modules_directories(modules_directories)
	{
		modules_directories = modules_directories.filter(x => x !== 'node_modules')

		// instrument Module._nodeModulePaths function
		// https://github.com/nodejs/node/blob/master/lib/module.js#L202
		//
		const original_find_paths = require('module')._findPath
		//
		require('module')._findPath = function(request, paths)
		{
			paths.map(function(a_path)
			{
				var parts = a_path.split(path.sep)
				if (parts[parts.length - 1] === 'node_modules')
				{
					parts[parts.length - 1] = ''
					return parts.join(path.sep)
				}
			})
			.filter(function(a_path)
			{
				return a_path
			})
			.forEach(function(a_path)
			{
				modules_directories.forEach(function(modules_directory)
				{
					paths.push(a_path + modules_directory)
				})
			})

			return original_find_paths(request, paths)
		}
	}

	// injects helper functions into `require()` function
	// (such as `.context()` and `.ensure()`)
	// https://github.com/halt-hammerzeit/webpack-isomorphic-tools/issues/48#issuecomment-182878437
	// (this is a "dirty" way to do it but it works)
	patch_require()
	{
		// a source code of a function that
		// require()s all modules inside the `base` folder
		// and puts them into a hash map for further reference
		//
		// https://webpack.github.io/docs/context.html
		//
		let require_context = `require.context = function(base, scan_subdirectories, regular_expression)
		{
			base = require('path').join(require('path').dirname(module.filename), base)

			var contents = {}

			// recursive function
			function read_directory(directory)
			{
				require('fs').readdirSync(directory).forEach(function(child)
				{
					var full_path = require('path').resolve(directory, child)

					if (require('fs').statSync(full_path).isDirectory())
					{
						if (scan_subdirectories)
						{
							read_directory(full_path)
						}
					}
					else
					{
						var asset_path = require('path').relative(base, full_path)

						// analogous to "uniform_path" from "./common.js"
						asset_path = (asset_path[0] === '.' ? asset_path : ('./' + asset_path)).replace(/\\\\/g, '/')

						if (regular_expression && !regular_expression.test(asset_path))
						{
							return
						}

						contents[asset_path] = full_path
					}
				})
			}

			read_directory(base)

			var result = function(asset_path)
			{
				return require(contents[asset_path])
			}

			result.keys = function()
			{
				return Object.keys(contents)
			}

			result.resolve = function(asset_path)
			{
				return contents[asset_path]
			}

			return result
		};`

		// some code minification
		require_context = UglifyJS.minify(require_context, { fromString: true }).code

		// Source code for `require.ensure()`
		// https://github.com/halt-hammerzeit/webpack-isomorphic-tools/issues/84
		const require_ensure = `require.ensure=function(d,c){c(require)};`

		const debug = this.log.debug.bind(this.log)

		// instrument Module.prototype._compile function
		// https://github.com/nodejs/node/blob/master/lib/module.js#L376-L380
		//
		const original_compile = require('module').prototype._compile
		//
		require('module').prototype._compile = function(content, filename)
		{
			// inject it only in .js files
			if (!ends_with(filename, '.js'))
			{
				// (the return value is supposed to be `undefined`)
				return original_compile.call(this, content, filename)
			}

			// will be prepended to the module source code
			let preamble = ''

			// inject it only in .js files which
			// might probably have `require.context` reference
			if (content.indexOf('require.context') >= 0)
			{
				debug(`Injecting require.context() into "${filename}"`)
				preamble += require_context
			}

			// inject it only in .js files which
			// might probably have `require.ensure` reference
			if (content.indexOf('require.ensure') >= 0)
			{
				debug(`Injecting require.ensure() into "${filename}"`)
				preamble += require_ensure
			}

			// If there is a preamble to prepend
			if (preamble)
			{
				// Account for "use strict" which is required to be in the beginning of the source code
				if (starts_with(content, `'use strict'`) || starts_with(content, `"use strict"`))
				{
					preamble = `"use strict";` + preamble
				}
			}

			// the "dirty" way
			content = preamble + content

			// (the return value is supposed to be `undefined`)
			return original_compile.call(this, content, filename)
		}
	}

	normalize_asset_path(global_asset_path)
	{
		// sanity check
		/* istanbul ignore if */
		if (!this.options.project_path)
		{
			throw new Error(`You forgot to call the .server() method passing it your project's base path`)
		}

		// convert global asset path to local-to-the-project asset path
		return normalize_asset_path(global_asset_path, this.options.project_path)
	}

	// require()s an asset by a global path
	require(global_asset_path, description)
	{
		this.log.debug(`require() called for ${global_asset_path}`)

		// convert global asset path to local-to-the-project asset path
		const asset_path = this.normalize_asset_path(global_asset_path)

		// if this filename is in the user specified exceptions list
		// (or is not in the user explicitly specified inclusion list)
		// then fall back to the normal require() behaviour
		if (!this.includes(asset_path, description) || this.excludes(asset_path, description))
		{
			this.log.debug(` skipping require call for ${asset_path}`)
			return
		}

		// find this asset in the list
		const asset = this.asset_source(asset_path)

		// if the asset was not found in the list, output an error
		if (asset === undefined)
		{
			this.log.error(`asset not found: ${asset_path}`)
		}

		return this.require_asset(asset, { require_cache_path: global_asset_path })
	}

	// require()s an asset by it source
	require_asset(asset, options)
	{
		// this.log.debug(`require() called for ${asset_path}`)

		// track cached assets (only in development mode)
		if (this.options.development)
		{
			// mark this asset as cached
			this.cached_assets.push(options.require_cache_path)
		}

		// return CommonJS module source for this asset
		return require_hacker.to_javascript_module_source(asset)
	}

	// returns asset source by path (looks it up in webpack-assets.json)
	asset_source(asset_path)
	{
		this.log.debug(` requiring ${asset_path}`)

		// Webpack replaces `node_modules` with `~`.
		// I don't know how exactly it decides whether to
		// replace `node_modules` with `~` or not
		// so it will be a guess.
		function possible_webpack_paths(asset_path)
		{
			// Webpack always replaces project's own `node_modules` with `~`
			if (starts_with(asset_path, './node_modules/'))
			{
				asset_path = asset_path.replace('./node_modules/', './~/')
			}

			// if there are any `node_modules` left,
			// supposing the count is N,
			// then there are 2 to the power of N possible guesses
			// on how webpack path might look like.
			const parts = asset_path.split('/node_modules/')

			function construct_guesses(parts)
			{
				if (parts.length === 1)
				{
					return [parts]
				}

				const last = parts.pop()
				const rest = construct_guesses(parts)

				const guesses = []

				for (let guess of rest)
				{
					const one = clone(guess)
					one.push('/~/')
					one.push(last)

					const two = clone(guess)
					two.push('/node_modules/')
					two.push(last)

					guesses.push(one)
					guesses.push(two)
				}

				return guesses
			}

			return construct_guesses(parts)
		}

		// get real file path list
		const assets = this.assets().assets

		const possible_webpack_asset_paths = possible_webpack_paths(asset_path).map(path => path.join(''))

		for (let webpack_asset_path of possible_webpack_asset_paths)
		{
			if (possible_webpack_asset_paths.length > 1)
			{
				this.log.debug(`  trying "${webpack_asset_path}"`)
			}

			// find this asset in the real file path list
			const asset = assets[webpack_asset_path]

			if (exists(asset))
			{
				// the asset was found in the list - return it
				return asset
			}
		}

		// if the asset was not found in the list, return nothing
		return
	}

	// unregisters require() hooks
	undo()
	{
		// for each user specified asset type,
		// unregister a require() hook for each file extension of this asset type
		for (let hook of this.hooks)
		{
			hook.unmount()
		}

		// this.asset_hook.unmount()

		// unmount the aliasing hook (if mounted)
		if (this.alias_hook)
		{
			this.alias_hook.unmount()
		}

		// unmount require() hook which intercepts loader-powered require() paths
		if (this.loaders_hook)
		{
			this.loaders_hook.unmount()
		}
	}

	// Checks if the required path should be excluded from the custom require() hook
	excludes(path, options)
	{
		// if "exclude" parameter isn't specified, then exclude nothing
		if (!exists(options.exclude))
		{
			return false
		}

		// for each exclusion case
		for (let exclude of options.exclude)
		{
			// supports regular expressions
			if (exclude instanceof RegExp)
			{
				if (exclude.test(path))
				{
					return true
				}
			}
			// check for a compex logic match
			else if (typeof exclude === 'function')
			{
				if (exclude(path))
				{
					return true
				}
			}
			// otherwise check for a simple textual match
			else
			{
				if (exclude === path)
				{
					return true
				}
			}
		}

		// no matches found.
		// returns false so that it isn't undefined (for testing purpose)
		return false
	}

	// Checks if the required path should be included in the custom require() hook
	includes(path, options)
	{
		// if "include" parameter isn't specified, then include everything
		if (!exists(options.include))
		{
			return true
		}

		// for each inclusion case
		for (let include of options.include)
		{
			// supports regular expressions
			if (include instanceof RegExp)
			{
				if (include.test(path))
				{
					return true
				}
			}
			// check for a compex logic match
			else if (typeof include === 'function')
			{
				if (include(path))
				{
					return true
				}
			}
			// otherwise check for a simple textual match
			else
			{
				if (include === path)
				{
					return true
				}
			}
		}

		// no matches found.
		// returns false so that it isn't undefined (for testing purpose)
		return false
	}

	// Waits for webpack-assets.json to be created after Webpack build process finishes
	//
	// The callback is called when `webpack-assets.json` has been found
	// (it's needed for development because `webpack-dev-server`
	//  and your application server are usually run in parallel).
	//
	wait_for_assets(done)
	{
		// condition check interval
		const check_interval = 300 // in milliseconds
		const message_interval = 2000 // in milliseconds

		// show the message not too often
		let message_timer = 0

		// selfie
		const tools = this

		// waits for condition to be met, then proceeds
		function wait_for(condition, proceed)
		{
			function check()
			{
				// if the condition is met, then proceed
				if (condition())
				{
					return proceed()
				}

				message_timer += check_interval

				if (message_timer >= message_interval)
				{
					message_timer = 0

					tools.log.debug(`(${tools.webpack_assets_path} not found)`)
					tools.log.info('(waiting for the first Webpack build to finish)')
				}

				setTimeout(check, check_interval)
			}

			check()
		}

		// wait for webpack-assets.json to be written to disk by Webpack
		// (setTimeout() for global.webpack_isomorphic_tools )

		let ready_check

		// either go over network
		if (this.options.development && this.options.port)
		{
			ready_check = () =>
			{
				try
				{
					request(this.options.port)
					return true
				}
				catch (error)
				{
					if (!starts_with(error.message, 'Server responded with status code 404:\nWebpack assets not generated yet')
						&& !starts_with(error.message, 'connect ECONNREFUSED')
						&& !starts_with(error.message, 'Request timed out after'))
					{
						this.log.error(`Couldn't contact webpack-isomorphic-tools plugin over HTTP. Using an empty stub for webpack assets map.`)
						this.log.error(error)
					}

					return false
				}
			}
		}
		// or read it from disk
		else
		{
			ready_check = () => fs.existsSync(this.webpack_assets_path)
		}

		setImmediate(() => wait_for(ready_check, done))

		// allows method chaining
		return this
	}
}

// Doesn't work with Babel 6 compiler
// // alias camel case for those who prefer it
// alias_properties_with_camel_case(webpack_isomorphic_tools.prototype)