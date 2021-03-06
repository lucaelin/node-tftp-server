const edfsm = require('edfsm');

function Packet (buf) {
	this.buf = buf;
	this.ptr = 0;
}

Packet.prototype.uint16 = function () {
	const uint16 = this.buf.readUInt16BE(this.ptr);
	this.ptr += 2;
	return uint16;
};

Packet.prototype.cstr = function () {
	const start = this.ptr;
	while (this.buf[this.ptr]) this.ptr++;
	return this.buf.slice(start, this.ptr++).toString();
};

Packet.prototype.endReached = function () {
	return this.ptr > this.buf.length;
};

const getErrorCode = (message) => {
	switch (message) {
		case 'File not found.': return 1;
		case 'Access violation.': return 2;
		case 'Disk full or allocation exceeded.': return 3;
		case 'Illegal TFTP operation.': return 4;
		case 'Unknown transfer ID.': return 5;
		case 'File already exists.': return 6;
		case 'No such user.': return 7;
	};
	return 0;
};

module.exports = (ingress, outgress) => edfsm({
	fsmName: 'connection',
	input: ingress,
	output: outgress,
	firstState: 'init'
}).state('init', (ctx, i, o, next) => {
	const req = new Packet(ctx.request);
	delete ctx.request;

	// Make sure this is a read request
	if (req.uint16() !== 1) return next(new Error('Illegal TFTP operation.'));

	// Read filename and make sure it has a value
	ctx.filename = req.cstr();
	if (!ctx.filename.length) return next(new Error('File not found.'));

	// Read mode
	ctx.mode = req.cstr();

	ctx.try = 0;

	// parse options according to rfc2347
	ctx.options = new Map();

	while (!req.endReached()) {
		const key = req.cstr();
		const val = req.cstr();
		if (key) ctx.options.set(key, val);
	}
	// console.log(ctx.options);

	next('getData');
}).state('getData', (ctx, i, o, next) => {
	// Start searching a route for given filename
	tryRoute(0);
	function tryRoute (i) {
		if (i >= ctx.routes.length) {
			// We haven't found a route
			next(new Error('File not found.'));
		} else if (!ctx.routes[i]) {
			// Route has been unregistered -> ignore
			tryRoute(i + 1);
		} else if (
			ctx.routes[i].filter === undefined ||
			(ctx.routes[i].filter instanceof RegExp && ctx.routes[i].filter.test(ctx.filename)) ||
			ctx.routes[i].filter === ctx.filename
		) {
			// Call handler
			ctx.routes[i].handler(ctx, (data) => {
				ctx.data = data;
				ctx.block = 0;
				ctx.blocksize = 512;
				next('oack');
			}, (err) => {
				if (err instanceof Error) next(err);
				else tryRoute(i + 1);
			});
		} else {
			tryRoute(i + 1);
		}
	}
}).state('oack', (ctx, i, o, next) => {
	// Abort after the third try
	if (ctx.try++ > 3) return next(null);

	if (!ctx.options.size) return next('prepareDataPacket');

	// Create header
	const header = Buffer.alloc(2);
	header.writeUInt16BE(6, 0); // Opcode

	const options = [...ctx.options.entries()].map(([k, v]) => {
		let acceptedValue;

		if (k === 'blksize') {
			ctx.blocksize = Math.min(v, 1428);
			acceptedValue = String(ctx.blocksize);
		} else if (k === 'windowsize') {
			acceptedValue = '1';
		} else if (k === 'tsize') {
			acceptedValue = String(ctx.data.length);
		}

		// console.log('option', k, v, '->', acceptedValue);

		const str = typeof acceptedValue === 'string' ? `${k}\0${acceptedValue}\0` : '';
		const option = Buffer.alloc(str.length);
		option.write(str, 0); // todo ascii
		return option;
	});

	const packet = Buffer.concat([header, ...options]);

	// Send OACK
	o(ctx.clientKey, packet);

	i(ctx.clientKey, (msg) => {
		// Ignore other packets and wrong block numbers
		if (msg.readUInt16BE(0) !== 4) return;
		if (msg.readUInt16BE(2) !== 0) return;

		// console.log('got ack for OACK', msg.readUInt16BE(2));

		// Successfully acked
		next('prepareDataPacket');
	});
	next.timeout(1000, 'oack');
}).state('prepareDataPacket', (ctx, i, o, next) => {
	// console.log('preparing packet', ctx.block + 1);
	// Create header
	const header = Buffer.alloc(4);
	header.writeUInt16BE(3, 0); // Opcode
	header.writeUInt16BE(ctx.block + 1, 2); // Block #

	// Slice the chunk of data to be sent
	const body = ctx.data.slice(ctx.block * ctx.blocksize, (ctx.block + 1) * ctx.blocksize);

	// Create packet
	ctx.packet = Buffer.concat([header, body]);
	ctx.block++;
	ctx.try = 0;

	// Next state
	next('sendDataPacket');
}).state('sendDataPacket', (ctx, i, o, next) => {
	// const percentage = 100 * (ctx.block * ctx.blocksize) / ctx.data.length
	// console.log('sending packet', ctx.block, 'length', ctx.packet.length, percentage.toFixed(0), '%', 'try', ctx.try);
	// Abort after the third try
	if (ctx.try++ > 3) return next(null);

	// Send prepared chunk
	o(ctx.clientKey, ctx.packet);

	// Wait for the right ack
	i(ctx.clientKey, (msg) => {
		// Ignore other packets and wrong block numbers
		if (msg.readUInt16BE(0) !== 4) return;
		if (msg.readUInt16BE(2) !== ctx.block) return;

		// console.log('got ack for', msg.readUInt16BE(2));

		// Successfully acked
		// If sent packet had full block size, send next packet
		// Otherwise end the FSM
		if (ctx.packet.length !== ctx.blocksize + 4) next(null);
		else next('prepareDataPacket');
	});

	// Set timeout for resending chunk
	next.timeout(1000, 'sendDataPacket');
}).final((ctx, i, o, end, err, lastState) => {
	// Send error message if FSM has been destroyed with an Error
	if (err) {
		// console.error(err);
		const error = Buffer.alloc(5 + err.message.length);
		error.writeUInt16BE(5, 0); // Opcode
		error.writeUInt16BE(getErrorCode(err.message), 2); // ErrorCode
		error.write(err.message, 4);
		o(ctx.clientKey, error);
	}

	// console.log('request complete');

	end();
});
